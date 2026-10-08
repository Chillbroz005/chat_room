const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const fail=(message,status=400)=>json({error:message},status);
const now=()=>Date.now();
const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n=6){const b=crypto.getRandomValues(new Uint8Array(n));return [...b].map(x=>chars[x%chars.length]).join('')}
function visitor(req){return (req.headers.get('X-Visitor-Id')||'').slice(0,80)}
async function digest(s){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function passwordHash(password,salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:10000,hash:'SHA-256'},material,256);return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function safeRoom(r,count=0){return {id:r.id,name:r.name,creatorName:r.creator_name,createdAt:r.created_at,expiresAt:r.expires_at,description:r.description||'',rules:r.rules||'',hasPassword:!!r.password_hash,memberCount:count}}
async function admin(db,req,id,env){if(isMaster(req,env))return true;const v=visitor(req),key=req.headers.get('X-Admin-Key')||'';if(!v||!key)return false;const row=await db.prepare('SELECT key_hash FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,v).first();return !!row&&await digest(key)===row.key_hash}
function isMaster(req,env){const expected=env.MASTER_ADMIN_CODE;const supplied=req.headers.get('X-Master-Code')||'';return !!expected&&supplied===expected}
async function member(db,req,id){const v=visitor(req);if(!v)return null;return db.prepare('SELECT * FROM members WHERE room_id=? AND visitor_id=?').bind(id,v).first()}
async function activity(db,id,text){await db.prepare('INSERT INTO activity(room_id,text,created_at) VALUES(?,?,?)').bind(id,text,now()).run()}
async function roomEvent(db,id,text){await db.prepare("INSERT INTO messages(room_id,sender_id,display_name,kind,text,gif_url,created_at) VALUES(?, '', '', 'event', ?, '', ?)").bind(id,text,now()).run()}
async function publicRoom(db,id){const r=await db.prepare('SELECT * FROM rooms WHERE id=? AND expires_at>?').bind(id,now()).first();if(!r)return null;const n=await db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id=?').bind(id).first();return safeRoom(r,n?.n||0)}
function trim(v,max){return String(v||'').trim().slice(0,max)}
export async function onRequest({request,env}){
 if(!env.DB)return fail('Cloudflare D1 binding DB is missing. See README setup.',503);
 const db=env.DB.withSession('first-primary'),method=request.method,path=new URL(request.url).pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean).map(decodeURIComponent),master=isMaster(request,env);
 try{
  const offeredMaster=request.headers.get('X-Master-Code')||'';if(offeredMaster&&!master){const ip=await digest(request.headers.get('CF-Connecting-IP')||visitor(request)),attempts=await db.prepare('SELECT COUNT(*) n FROM master_attempts WHERE visitor_id=? AND created_at>?').bind(ip,now()-900000).first();if((attempts?.n||0)>=5)return fail('Too many master-code attempts. Try again in 15 minutes.',429);await db.prepare('INSERT INTO master_attempts(visitor_id,created_at) VALUES(?,?)').bind(ip,now()).run()}
  await db.prepare('DELETE FROM rooms WHERE expires_at<=?').bind(now()).run();
  if(path.length===1&&path[0]==='rooms'&&method==='GET'){
   const rows=await db.prepare('SELECT r.*,COUNT(m.visitor_id) member_count FROM rooms r LEFT JOIN members m ON m.room_id=r.id WHERE r.expires_at>? GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100').bind(now()).all();return json({rooms:(rows.results||[]).map(r=>safeRoom(r,r.member_count))});
  }
  if(path.length===1&&path[0]==='media'&&method==='GET'){
   if(!env.GIPHY_API_KEY)return fail('GIF and sticker search is not configured yet. Add GIPHY_API_KEY in Pages settings.',503);
   return json({apiKey:env.GIPHY_API_KEY});
  }
  if(path.length===1&&path[0]==='rooms'&&method==='POST'){
   const body=await request.json(),v=visitor(request);if(!v)return fail('Browser identity is missing. Refresh and retry.');
   const expires=Number(body.expiresMinutes);if(!Number.isInteger(expires)||expires<1||expires>43200)return fail('Expiry must be from 1 minute to 30 days.');
   const roomId=code(),created=now(),name=trim(body.name,48)||`${['Cozy','Happy','Quiet','Sunny','Friendly'][Math.floor(Math.random()*5)]} ${['Corner','Club','Lounge','Room','Hideout'][Math.floor(Math.random()*5)]}`,creator=trim(body.creatorName,24)||'Sunny Fox',adminKey=code(8),salt=code(16),pass=trim(body.password,64),pHash=pass?await passwordHash(pass,salt):null;if(pass&&pass.length<4)return fail('Password must be at least 4 characters.');
   await db.batch([db.prepare('INSERT INTO rooms(id,name,creator_name,creator_id,created_at,expires_at,description,password_salt,password_hash) VALUES(?,?,?,?,?,?,?,?,?)').bind(roomId,name,creator,v,created,created+expires*60000,trim(body.description,180),pass?salt:null,pHash),db.prepare('INSERT INTO room_admins(room_id,visitor_id,key_hash) VALUES(?,?,?)').bind(roomId,v,await digest(adminKey)),db.prepare('INSERT INTO members(room_id,visitor_id,display_name,joined_at,last_seen) VALUES(?,?,?,?,?)').bind(roomId,v,creator,created,created),db.prepare('INSERT INTO activity(room_id,text,created_at) VALUES(?,?,?)').bind(roomId,`${creator} created the room`,created),db.prepare("INSERT INTO messages(room_id,sender_id,display_name,kind,text,created_at) VALUES(?,?,'','event',?,?)").bind(roomId,'',`${creator} created the room`,created)]);
   return json({room:await publicRoom(db,roomId),adminKey,creatorName:creator},201);
  }
  if(path[0]!=='rooms'||!path[1])return fail('Not found.',404);
  const id=path[1].toUpperCase(),room=await db.prepare('SELECT * FROM rooms WHERE id=? AND expires_at>?').bind(id,now()).first();if(!room)return fail('Room not found or expired.',404);
  if(path.length===2&&method==='GET'){
   const m=await member(db,request,id);if(!m&&!master){if(await db.prepare('SELECT 1 FROM blocked WHERE room_id=? AND visitor_id=?').bind(id,visitor(request)).first())return fail('You are blocked from this room.',403);return json({room:await publicRoom(db,id)})}
   const isAdmin=await admin(db,request,id,env),v=visitor(request);if(m)await db.prepare('UPDATE members SET last_seen=? WHERE room_id=? AND visitor_id=?').bind(now(),id,v).run();
   const messageSql=master?'SELECT m.*,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin FROM messages m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.sender_id WHERE m.room_id=? ORDER BY m.id':'SELECT m.*,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin FROM messages m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.sender_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 150';
   const activitySql=master?'SELECT text,created_at FROM activity WHERE room_id=? ORDER BY id':'SELECT text,created_at FROM activity WHERE room_id=? ORDER BY id DESC LIMIT 40';
   const [messages,members,activityRows]=await Promise.all([db.prepare(messageSql).bind(id).all(),db.prepare('SELECT m.visitor_id,m.display_name,m.last_seen,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin,CASE WHEN z.visitor_id IS NULL THEN 0 ELSE 1 END AS muted FROM members m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.visitor_id LEFT JOIN muted z ON z.room_id=m.room_id AND z.visitor_id=m.visitor_id WHERE m.room_id=? ORDER BY m.joined_at').bind(id).all(),isAdmin?db.prepare(activitySql).bind(id).all():Promise.resolve({results:[]})]);
   return json({room:safeRoom(room,(members.results||[]).length),messages:(messages.results||[]).reverse().map(x=>({id:x.id,senderId:x.sender_id,displayName:x.display_name,kind:x.kind,text:x.text,gifUrl:x.gif_url,createdAt:x.created_at,role:x.is_admin?'admin':'member'})),members:(members.results||[]).map(x=>({visitorId:x.visitor_id,displayName:x.display_name,lastSeen:x.last_seen,role:x.is_admin||(isAdmin&&x.visitor_id===v)?'admin':'member',muted:!!x.muted})),activity:(activityRows.results||[]).reverse()});
  }
  if(path.length===3&&path[2]==='join'&&method==='POST'){
   const b=await request.json(),v=visitor(request),credential=request.headers.get('X-Admin-Key')||'',joinMaster=master||!!env.MASTER_ADMIN_CODE&&credential===env.MASTER_ADMIN_CODE;if(!v)return fail('Browser identity is missing.');
   if(!master&&!joinMaster&&credential){const adminRow=await db.prepare('SELECT key_hash FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,v).first(),validAdmin=!!adminRow&&await digest(credential)===adminRow.key_hash;if(!validAdmin){const attemptId=await digest(request.headers.get('CF-Connecting-IP')||v),tries=await db.prepare('SELECT COUNT(*) n FROM master_attempts WHERE visitor_id=? AND created_at>?').bind(attemptId,now()-900000).first();if((tries?.n||0)>=5)return fail('Too many admin or master-code attempts. Try again in 15 minutes.',429);await db.prepare('INSERT INTO master_attempts(visitor_id,created_at) VALUES(?,?)').bind(attemptId,now()).run()}}
   if(!joinMaster&&await db.prepare('SELECT 1 FROM blocked WHERE room_id=? AND visitor_id=?').bind(id,v).first())return fail('You are blocked from this room.',403);
   const existing=await member(db,request,id);
   if(!existing&&!joinMaster&&room.password_hash){const attemptId=await digest(request.headers.get('CF-Connecting-IP')||v),tries=await db.prepare('SELECT COUNT(*) n FROM join_attempts WHERE room_id=? AND visitor_id=? AND created_at>?').bind(id,attemptId,now()-900000).first();if((tries?.n||0)>=5)return fail('Too many password attempts. Try again in 15 minutes.',429);const h=await passwordHash(trim(b.password,64),room.password_salt);if(h!==room.password_hash){await db.prepare('INSERT INTO join_attempts(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,attemptId,now()).run();return fail('Incorrect room password.',403)}}
   if(!existing){const dn=trim(b.displayName,24)||'Friendly Guest';await db.prepare('INSERT INTO members(room_id,visitor_id,display_name,joined_at,last_seen) VALUES(?,?,?,?,?)').bind(id,v,dn,now(),now()).run();await activity(db,id,`${dn} joined the room`);await roomEvent(db,id,`${dn} joined the room`)}else await db.prepare('UPDATE members SET last_seen=? WHERE room_id=? AND visitor_id=?').bind(now(),id,v).run();
   const isAdmin=await admin(db,request,id,env)||joinMaster,m=await member(db,request,id);return json({room:await publicRoom(db,id),member:{displayName:m.display_name,role:isAdmin?'admin':'member',isCreator:room.creator_id===v,isMaster:joinMaster}});
  }
  if(path.length===3&&path[2]==='leave'&&method==='POST'){const v=visitor(request),m=await member(db,request,id);if(m){await db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,v).run();await activity(db,id,`${m.display_name} left the room`);await roomEvent(db,id,`${m.display_name} left the room`)}return json({ok:true})}
  if(path.length===3&&path[2]==='messages'&&method==='POST'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);if(await db.prepare('SELECT 1 FROM muted WHERE room_id=? AND visitor_id=?').bind(id,v).first())return fail('You are muted in this room. You can still read messages.',403);const b=await request.json(),kind=b.kind==='gif'?'gif':'text',text=trim(b.text,255);if(kind==='text'&&!text)return fail('Message cannot be empty.');let gif='';if(kind==='gif'){try{const u=new URL(String(b.gifUrl||''));if(u.protocol!=='https:'||u.href.length>500)throw 0;gif=u.href}catch{return fail('GIF URL must be a valid HTTPS link under 500 characters.')}}
   await db.prepare('INSERT INTO messages(room_id,sender_id,display_name,kind,text,gif_url,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,v,m.display_name,kind,text,gif,now()).run();return json({ok:true},201);
  }
  if(path.length===4&&path[2]==='messages'&&method==='DELETE'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can delete messages.',403);const mid=Number(path[3]);await db.prepare('DELETE FROM messages WHERE id=? AND room_id=?').bind(mid,id).run();await activity(db,id,'An admin deleted a message');return json({ok:true});
  }
  if(path.length===3&&path[2]==='settings'&&method==='PATCH'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can change settings.',403);const b=await request.json(),mins=Number(b.expiresMinutes);if(!Number.isInteger(mins)||mins<1||mins>43200)return fail('Expiry must be from 1 minute to 30 days.');await db.prepare('UPDATE rooms SET name=?,description=?,rules=?,expires_at=? WHERE id=?').bind(trim(b.name,48)||room.name,trim(b.description,180),trim(b.rules,500),now()+mins*60000,id).run();await activity(db,id,'Room settings updated');return json({room:await publicRoom(db,id)});
  }
  if(path.length===3&&path[2]==='password'&&method==='PUT'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can change the password.',403);const b=await request.json(),p=trim(b.password,64);if(p&&p.length<4)return fail('Password must be at least 4 characters.');const salt=p?code(16):null,hash=p?await passwordHash(p,salt):null;await db.prepare('UPDATE rooms SET password_salt=?,password_hash=? WHERE id=?').bind(salt,hash,id).run();await activity(db,id,p?'Room password changed':'Room password removed');return json({ok:true});
  }
  if(path.length===3&&path[2]==='block'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can block members.',403);const b=await request.json(),target=String(b.targetId||'');if(!target)return fail('Choose a member to block.');await db.batch([db.prepare('INSERT OR IGNORE INTO blocked(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,target,now()),db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,target)]);await activity(db,id,'An admin blocked a member');return json({ok:true});
  }
  if(path.length===3&&path[2]==='admins'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can nominate admins.',403);const b=await request.json(),target=String(b.targetId||''),m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!m)return fail('That member is no longer in the room.');const key=code(8);await db.prepare('INSERT OR REPLACE INTO room_admins(room_id,visitor_id,key_hash) VALUES(?,?,?)').bind(id,target,await digest(key)).run();await activity(db,id,`${m.display_name} was made an admin`);return json({adminKey:key,displayName:m.display_name});
  }
  if(path.length===3&&path[2]==='mute'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can mute members.',403);const b=await request.json(),target=String(b.targetId||'');if(!target)return fail('Choose a member.');const m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!m)return fail('That member is not in the room.');await db.prepare('INSERT OR IGNORE INTO muted(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,target,now()).run();await activity(db,id,`${m.display_name} was muted`);return json({ok:true});
  }
  if(path.length===3&&path[2]==='unmute'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can unmute members.',403);const b=await request.json(),target=String(b.targetId||'');await db.prepare('DELETE FROM muted WHERE room_id=? AND visitor_id=?').bind(id,target).run();const m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();await activity(db,id,`${m?.display_name||'A member'} was unmuted`);return json({ok:true});
  }
  if(path.length===2&&method==='DELETE'){
   const owner=await db.prepare('SELECT creator_id FROM rooms WHERE id=?').bind(id).first();if(!master&&owner?.creator_id!==visitor(request))return fail('Only the room creator or master admin can delete this room.',403);await db.prepare('DELETE FROM rooms WHERE id=?').bind(id).run();return json({ok:true});
  }
  return fail('Not found.',404);
 }catch(e){return fail(e?.message||'Server error.',500)}
}
