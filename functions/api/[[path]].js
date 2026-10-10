const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','permissions-policy':'camera=(), microphone=(), geolocation=()'}});
const fail=(message,status=400)=>json({error:message},status);
const now=()=>Date.now();
const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n=6){const b=crypto.getRandomValues(new Uint8Array(n));return [...b].map(x=>chars[x%chars.length]).join('')}
function visitor(req){return (req.headers.get('X-Visitor-Id')||'').slice(0,80)}
async function digest(s){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function passwordHash(password,salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:10000,hash:'SHA-256'},material,256);return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function accountPasswordHash(password,salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},material,256);return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function safeRoom(r,count=0){return {id:r.id,name:r.name,creatorName:r.creator_name,createdAt:r.created_at,expiresAt:r.expires_at,description:r.description||'',rules:r.rules||'',hasPassword:!!r.password_hash,memberCount:count}}
async function admin(db,req,id,env){if(isMaster(req,env))return true;const v=visitor(req);if(!v)return false;const account=await currentAccount(db,req);if(account){const owner=await db.prepare('SELECT creator_account_id FROM rooms WHERE id=?').bind(id).first();if(owner?.creator_account_id&&owner.creator_account_id===account.id)return true}const key=req.headers.get('X-Admin-Key')||'';if(!key)return false;const row=await db.prepare('SELECT key_hash FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,v).first();return !!row&&await digest(key)===row.key_hash}
function isMaster(req,env){const expected=env.MASTER_ADMIN_CODE;const supplied=req.headers.get('X-Master-Code')||'';return !!expected&&supplied===expected}
async function member(db,req,id){const v=visitor(req);if(!v)return null;return db.prepare('SELECT * FROM members WHERE room_id=? AND visitor_id=?').bind(id,v).first()}
async function activity(db,id,text){await db.prepare('INSERT INTO activity(room_id,text,created_at) VALUES(?,?,?)').bind(id,text,now()).run()}
async function roomEvent(db,id,text){await db.prepare("INSERT INTO messages(room_id,sender_id,display_name,kind,text,gif_url,created_at) VALUES(?, '', '', 'event', ?, '', ?)").bind(id,text,now()).run()}
async function publicRoom(db,id){const r=await db.prepare('SELECT * FROM rooms WHERE id=? AND expires_at>?').bind(id,now()).first();if(!r)return null;const n=await db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id=?').bind(id).first();return safeRoom(r,n?.n||0)}
function trim(v,max){return String(v||'').trim().slice(0,max)}
// D1-backed rolling-window limits. Store hashes rather than raw IP/session identifiers.
async function consumeRateLimit(db,action,subject,limit,windowMs,roomId=null){
 const stamp=now(),subjectHash=await digest(subject);
 const row=await db.prepare('SELECT COUNT(*) AS n FROM api_rate_limits WHERE action=? AND subject_hash=? AND created_at>?').bind(action,subjectHash,stamp-windowMs).first();
 if((row?.n||0)>=limit)return false;
 await db.prepare('INSERT INTO api_rate_limits(action,subject_hash,room_id,created_at) VALUES(?,?,?,?)').bind(action,subjectHash,roomId,stamp).run();
 if(stamp%17===0)await db.prepare('DELETE FROM api_rate_limits WHERE created_at<?').bind(stamp-86400000).run();
 return true;
}
async function sendCreatorTelegram(db,env,request,id,room,displayName,text){
 if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return 'not_configured';
 const recent=await db.prepare("SELECT COUNT(*) n FROM activity WHERE room_id=? AND text='@creator Telegram alert sent' AND created_at>?").bind(id,now()-300000).first();
 if((recent?.n||0)>0)return 'rate_limited';
 const invite=new URL(request.url);invite.pathname='/';invite.search='';invite.hash='';invite.searchParams.set('room',id);
 const message=`@creator mention in ${room.name} (${id})\nFrom: ${displayName}\nMessage: ${text.slice(0,255)}\nJoin room: ${invite.toString()}\n\nReply to this alert to post back into the room, or send /reply ${id} your message.`;
 try{
  const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:message})});
  const result=await response.json();
  if(response.ok&&result.ok){await activity(db,id,'@creator Telegram alert sent');return 'sent'}
  const reason=String(result?.description||`HTTP ${response.status}`).replace(/[\r\n]+/g,' ').slice(0,140);
  await activity(db,id,`@creator Telegram alert failed: ${reason}`);
  return `failed:${reason}`;
 }catch{
  await activity(db,id,'@creator Telegram alert failed: network error');
  return 'failed:network error';
 }
}
function constantTimeEqual(a,b){if(a.length!==b.length)return false;let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0}
async function sendTelegramNotice(env,chatId,text){if(!env.TELEGRAM_BOT_TOKEN)return;try{await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text})})}catch{}}
function parseTelegramReply(message){const text=String(message?.text||'').trim(),command=text.match(/^\/reply(?:@\w+)?\s+([A-Z0-9]{6})\s+([\s\S]+)$/i);if(command)return {roomId:command[1].toUpperCase(),text:command[2].trim()};if(text.startsWith('/reply'))return {error:'Use /reply ROOMCODE message, or reply directly to a @creator alert.'};const original=message?.reply_to_message;if(!original?.from?.is_bot||!original.text)return {error:'Reply to a @creator alert, or use /reply ROOMCODE message.'};const match=String(original.text).match(/^@creator mention in [\s\S]*\(([A-Z0-9]{6})\)\r?\nFrom:/i);if(!match)return {error:'That Telegram message is not a Husky creator alert.'};return {roomId:match[1].toUpperCase(),text}}
async function handleTelegramWebhook(request,env,db){const expected=String(env.TELEGRAM_WEBHOOK_SECRET||''),supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'';if(!expected)return fail('Telegram reply webhook is not configured.',503);if(!constantTimeEqual(supplied,expected))return fail('Webhook authentication failed.',403);if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID||!env.TELEGRAM_CREATOR_USER_ID)return fail('Telegram reply settings are incomplete.',503);let update;try{update=await request.json()}catch{return fail('Invalid Telegram update.')}const message=update?.message;if(!Number.isInteger(update?.update_id)||!message)return json({ok:true});if(String(message.chat?.id)!==String(env.TELEGRAM_CHAT_ID)||String(message.from?.id)!==String(env.TELEGRAM_CREATOR_USER_ID)||message.from?.is_bot)return json({ok:true});const reply=parseTelegramReply(message);if(reply.error){await sendTelegramNotice(env,message.chat.id,reply.error);return json({ok:true})}if(!reply.text)return json({ok:true});if(reply.text.length>255){await sendTelegramNotice(env,message.chat.id,'That reply is over Husky’s 255-character limit and was not posted.');return json({ok:true})}const room=await db.prepare('SELECT id FROM rooms WHERE id=? AND expires_at>?').bind(reply.roomId,now()).first();if(!room){await sendTelegramNotice(env,message.chat.id,`Room ${reply.roomId} was not found or has expired.`);return json({ok:true})}const timestamp=now(),senderId=`telegram:${message.from.id}`,displayName='Husky Creator (Telegram)',body=reply.text;await db.prepare('DELETE FROM telegram_updates WHERE created_at<?').bind(timestamp-90*86400000).run();const result=await db.batch([db.prepare('INSERT OR IGNORE INTO telegram_updates(update_id,created_at) VALUES(?,?)').bind(update.update_id,timestamp),db.prepare("INSERT INTO messages(room_id,sender_id,display_name,kind,text,gif_url,created_at) SELECT ?,?,?,'text',?,'',? WHERE changes()=1").bind(room.id,senderId,displayName,body,timestamp),db.prepare('INSERT INTO activity(room_id,text,created_at) SELECT ?,?,? WHERE changes()=1').bind(room.id,'Husky Creator replied via Telegram',timestamp)]);if(!result?.[1]?.meta?.changes)return json({ok:true,duplicate:true});await sendTelegramNotice(env,message.chat.id,`Sent to ${reply.roomId}.`);return json({ok:true})}
async function currentAccount(db,req){const v=visitor(req);if(!v)return null;return db.prepare('SELECT a.id,a.username,a.avatar FROM browser_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.visitor_id=?').bind(v).first()}
const accountAvatars=['🐺','🐼','🦊','🐯','🐸','🐨','🐙','🚀','🌟','🎧','👾','🐧'];
async function reserveAnonymousName(db,roomId,visitorId){
 const saved=await db.prepare('SELECT display_name FROM room_usernames WHERE room_id=? AND visitor_id=?').bind(roomId,visitorId).first();if(saved)return saved.display_name;
 const first=['Amber','Brisk','Calm','Clever','Cosmic','Daring','Gentle','Golden','Happy','Jolly','Lucky','Misty','Mellow','Quiet','Silver','Sunny','Swift','Velvet','Wild','Witty'];
 const second=['Badger','Comet','Dolphin','Falcon','Fox','Gecko','Heron','Koala','Lynx','Marten','Otter','Panda','Puffin','Raven','Robin','Tiger','Wombat','Yak','Finch','Husky'];
 for(let attempt=0;attempt<40;attempt++){
  const name=`${first[crypto.getRandomValues(new Uint8Array(1))[0]%first.length]} ${second[crypto.getRandomValues(new Uint8Array(1))[0]%second.length]}-${code(4)}`;
  const taken=await db.prepare('SELECT 1 FROM room_usernames WHERE room_id=? AND display_name=? UNION ALL SELECT 1 FROM members WHERE room_id=? AND display_name=? LIMIT 1').bind(roomId,name,roomId,name).first();if(taken)continue;
  await db.prepare('INSERT OR IGNORE INTO room_usernames(room_id,display_name,visitor_id,assigned_at) VALUES(?,?,?,?)').bind(roomId,name,visitorId,now()).run();
  const assigned=await db.prepare('SELECT display_name FROM room_usernames WHERE room_id=? AND visitor_id=?').bind(roomId,visitorId).first();if(assigned)return assigned.display_name;
 }
 throw new Error('Could not assign a unique anonymous username. Please retry.');
}
async function handleRequest({request,env}){
 if(!env.DB)return fail('Cloudflare D1 binding DB is missing. See README setup.',503);
 const db=env.DB.withSession('first-primary'),method=request.method,path=new URL(request.url).pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean).map(decodeURIComponent),master=isMaster(request,env);
 try{
  const offeredMaster=request.headers.get('X-Master-Code')||'';if(offeredMaster&&!master){const ip=await digest(request.headers.get('CF-Connecting-IP')||visitor(request)),attempts=await db.prepare('SELECT COUNT(*) n FROM master_attempts WHERE visitor_id=? AND created_at>?').bind(ip,now()-900000).first();if((attempts?.n||0)>=5)return fail('Too many master-code attempts. Try again in 15 minutes.',429);await db.prepare('INSERT INTO master_attempts(visitor_id,created_at) VALUES(?,?)').bind(ip,now()).run()}
  await db.prepare('DELETE FROM rooms WHERE expires_at<=?').bind(now()).run();
  if(path.length===1&&path[0]==='telegram-webhook'&&method==='POST')return await handleTelegramWebhook(request,env,db);
  if(path.length===1&&path[0]==='account'&&method==='GET'){const account=await currentAccount(db,request);return json({account:account?{username:account.username,avatar:account.avatar}:null})}
  if(path.length===2&&path[0]==='account'&&['signup','login'].includes(path[1])&&method==='POST'){
   const v=visitor(request);if(!v)return fail('Browser identity is missing.');
   const b=await request.json(),identifier=trim(b.username,254),username=trim(b.username,24),email=trim(b.email,254).toLowerCase(),password=String(b.password||''),action=path[1],stamp=now(),windowStart=stamp-15*60*1000,ip=digest(request.headers.get('CF-Connecting-IP')||'unknown-client'),userKey=digest(identifier.toLowerCase());
   const [ipCount,userCount]=await Promise.all([db.prepare('SELECT COUNT(*) n FROM account_auth_attempts WHERE ip_hash=? AND created_at>?').bind(await ip,windowStart).first(),db.prepare('SELECT COUNT(*) n FROM account_auth_attempts WHERE username_key=? AND created_at>?').bind(await userKey,windowStart).first()]);
   if((ipCount?.n||0)>=20||(userCount?.n||0)>=10)return fail('Too many sign-in attempts. Please wait 15 minutes and try again.',429);
   await db.prepare('INSERT INTO account_auth_attempts(ip_hash,username_key,action,created_at) VALUES(?,?,?,?)').bind(await ip,await userKey,action,stamp).run();
   if(stamp%10===0)await db.prepare('DELETE FROM account_auth_attempts WHERE created_at<?').bind(stamp-24*60*60*1000).run();
   if(action==='signup'&&!/^[A-Za-z0-9_]{3,24}$/.test(username))return fail('Use 3–24 letters, numbers or underscores for the username.');
   if(action==='signup'&&(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return fail('Enter a valid email address.');
   if(action==='signup'&&(password.length<8||password.length>128))return fail('Password must be 8–128 characters.');
   if(action==='login'&&!identifier)return fail('Enter your username or email address.');
   if(action==='login'&&!password)return fail('Enter your password.');
   let account;
   if(action==='signup'){
    const salt=code(24),hash=await accountPasswordHash(password,salt),avatar=accountAvatars.includes(b.avatar)?b.avatar:'🐺';
    account={id:crypto.randomUUID(),username,avatar};
    try{await db.prepare('INSERT INTO accounts(id,username,email,password_salt,password_hash,avatar,created_at) VALUES(?,?,?,?,?,?,?)').bind(account.id,username,email,salt,hash,avatar,now()).run()}
    catch(e){if(/unique|constraint/i.test(String(e))){const taken=await db.prepare('SELECT email FROM accounts WHERE username=? COLLATE NOCASE').bind(username).first();return fail(taken?'That username is already taken.':'That email address is already registered.',409)}throw e}
   }else{
    account=await db.prepare('SELECT id,username,avatar,password_salt,password_hash FROM accounts WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE LIMIT 1').bind(identifier,identifier.toLowerCase()).first();
    if(!account||!constantTimeEqual(await accountPasswordHash(password,account.password_salt),account.password_hash))return fail('Incorrect username/email or password.',401)
   }
   await db.prepare('DELETE FROM browser_accounts WHERE visitor_id=?').bind(v).run();await db.prepare('INSERT INTO browser_accounts(visitor_id,account_id,linked_at) VALUES(?,?,?)').bind(v,account.id,now()).run();await db.prepare('UPDATE members SET display_name=? WHERE visitor_id=?').bind(account.username,v).run();await db.prepare('UPDATE messages SET display_name=? WHERE sender_id=?').bind(account.username,v).run();await db.prepare('UPDATE rooms SET creator_name=? WHERE creator_id=?').bind(account.username,v).run();return json({account:{username:account.username,avatar:account.avatar}},action==='signup'?201:200)
  }
  if(path.length===2&&path[0]==='account'&&path[1]==='logout'&&method==='POST'){await db.prepare('DELETE FROM browser_accounts WHERE visitor_id=?').bind(visitor(request)).run();return json({ok:true})}
  if(path.length===2&&path[0]==='account'&&path[1]==='profile'&&method==='POST'){const account=await currentAccount(db,request);if(!account)return fail('Log in first.',401);const b=await request.json(),avatar=String(b.avatar||'');if(!accountAvatars.includes(avatar))return fail('Choose a supported profile icon.');await db.prepare('UPDATE accounts SET avatar=? WHERE id=?').bind(avatar,account.id).run();return json({account:{username:account.username,avatar}})}
  if(path.length===1&&path[0]==='rooms'&&method==='GET'){
   const stamp=now();const [rows,stats]=await Promise.all([db.prepare("SELECT r.*,COUNT(m.visitor_id) member_count,SUM(CASE WHEN m.last_seen>? THEN 1 ELSE 0 END) online_count,(SELECT COUNT(*) FROM messages x WHERE x.room_id=r.id AND x.kind!='event') message_count FROM rooms r LEFT JOIN members m ON m.room_id=r.id WHERE r.expires_at>? GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100").bind(stamp-30000,stamp).all(),db.prepare("SELECT (SELECT COUNT(*) FROM rooms WHERE expires_at>?) room_count,(SELECT COUNT(*) FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>? AND m.kind!='event') message_count,(SELECT COUNT(*) FROM members m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>?) member_count,(SELECT COUNT(*) FROM members m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>? AND m.last_seen>?) online_count").bind(stamp,stamp,stamp,stamp,stamp-30000).first()]);return json({rooms:(rows.results||[]).map(r=>({...safeRoom(r,r.member_count),onlineCount:r.online_count||0,messageCount:r.message_count})),stats:{rooms:stats?.room_count||0,messages:stats?.message_count||0,members:stats?.member_count||0,online:stats?.online_count||0}});
  }
  if(path.length===1&&path[0]==='master'&&method==='GET'){
   if(!master)return fail('Master admin access is required.',403);
   const masterVisitor=visitor(request);if(masterVisitor)await db.prepare('DELETE FROM members WHERE visitor_id=?').bind(masterVisitor).run();
   const stamp=now();const [rows,stats]=await Promise.all([db.prepare("SELECT r.*,COUNT(m.visitor_id) member_count,SUM(CASE WHEN m.last_seen>? THEN 1 ELSE 0 END) online_count,(SELECT COUNT(*) FROM messages x WHERE x.room_id=r.id AND x.kind!='event') message_count FROM rooms r LEFT JOIN members m ON m.room_id=r.id WHERE r.expires_at>? GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100").bind(stamp-30000,stamp).all(),db.prepare("SELECT (SELECT COUNT(*) FROM rooms WHERE expires_at>?) room_count,(SELECT COUNT(*) FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>? AND m.kind!='event') message_count,(SELECT COUNT(*) FROM members m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>?) member_count,(SELECT COUNT(*) FROM members m JOIN rooms r ON r.id=m.room_id WHERE r.expires_at>? AND m.last_seen>?) online_count").bind(stamp,stamp,stamp,stamp,stamp-30000).first()]);
   return json({rooms:(rows.results||[]).map(r=>({...safeRoom(r,r.member_count),onlineCount:r.online_count||0,messageCount:r.message_count})),stats:{rooms:stats?.room_count||0,messages:stats?.message_count||0,members:stats?.member_count||0,online:stats?.online_count||0}});
  }
  if(path.length===1&&path[0]==='media'&&method==='GET'){
   if(!env.GIPHY_API_KEY)return fail('GIF and sticker search is not configured yet. Add GIPHY_API_KEY in Pages settings.',503);
   return json({apiKey:env.GIPHY_API_KEY});
  }
  if(path.length===1&&path[0]==='rooms'&&method==='POST'){
   const body=await request.json(),v=visitor(request);if(!v)return fail('Browser identity is missing. Refresh and retry.');
   const clientIp=request.headers.get('CF-Connecting-IP')||v;
   if(!await consumeRateLimit(db,'room_create_visitor',v,5,15*60*1000))return json({error:'Too many rooms created from this browser. Please wait 15 minutes and try again.'},429);
   if(!await consumeRateLimit(db,'room_create_ip',clientIp,10,15*60*1000))return json({error:'Too many rooms created from this network. Please wait 15 minutes and try again.'},429);
   const expires=Number(body.expiresMinutes);if(!Number.isInteger(expires)||expires<1||expires>43200)return fail('Expiry must be from 1 minute to 30 days.');
   const account=await currentAccount(db,request),roomId=code(),created=now(),name=trim(body.name,48)||`${['Cozy','Happy','Quiet','Sunny','Friendly'][Math.floor(Math.random()*5)]} ${['Corner','Club','Lounge','Room','Hideout'][Math.floor(Math.random()*5)]}`,creator=account?.username||trim(body.creatorName,24)||'Sunny Fox',adminKey=code(8),salt=code(16),pass=trim(body.password,64),pHash=pass?await passwordHash(pass,salt):null;if(pass&&pass.length<8)return fail('Room passwords must be at least 8 characters.');if(await db.prepare('SELECT 1 FROM rooms WHERE name=? COLLATE NOCASE AND expires_at>? LIMIT 1').bind(name,created).first())return fail('That room name is already taken. Choose a different name.',409);
   await db.batch([db.prepare('INSERT INTO rooms(id,name,creator_name,creator_id,creator_account_id,created_at,expires_at,description,password_salt,password_hash) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(roomId,name,creator,v,account?.id||null,created,created+expires*60000,trim(body.description,180),pass?salt:null,pHash),db.prepare('INSERT INTO room_admins(room_id,visitor_id,key_hash) VALUES(?,?,?)').bind(roomId,v,await digest(adminKey)),db.prepare('INSERT INTO members(room_id,visitor_id,display_name,joined_at,last_seen) VALUES(?,?,?,?,?)').bind(roomId,v,creator,created,created),db.prepare('INSERT INTO activity(room_id,text,created_at) VALUES(?,?,?)').bind(roomId,`${creator} created the room`,created),db.prepare("INSERT INTO messages(room_id,sender_id,display_name,kind,text,created_at) VALUES(?,?,'','event',?,?)").bind(roomId,'',`${creator} created the room`,created)]);
   return json({room:await publicRoom(db,roomId),...(account?{}:{adminKey}),creatorName:creator},201);
  }
  if(path[0]!=='rooms'||!path[1])return fail('Not found.',404);
  const id=path[1].toUpperCase(),room=await db.prepare('SELECT * FROM rooms WHERE id=? AND expires_at>?').bind(id,now()).first();if(!room)return fail('Room not found or expired.',404);
  if(path.length===2&&method==='GET'){
   let m=await member(db,request,id);if(master&&m){await db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,visitor(request)).run();m=null}if(!m&&!master){if(await db.prepare('SELECT 1 FROM blocked WHERE room_id=? AND visitor_id=?').bind(id,visitor(request)).first())return fail('You are blocked from this room.',403);return json({room:await publicRoom(db,id)})}
   const isAdmin=await admin(db,request,id,env),v=visitor(request),account=await currentAccount(db,request);if(m)await db.prepare('UPDATE members SET last_seen=? WHERE room_id=? AND visitor_id=?').bind(now(),id,v).run();
   const messageSql=master?'SELECT m.*,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin FROM messages m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.sender_id WHERE m.room_id=? ORDER BY m.id':'SELECT m.*,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin FROM messages m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.sender_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 150';
   const activitySql=master?'SELECT text,created_at FROM activity WHERE room_id=? ORDER BY id':'SELECT text,created_at FROM activity WHERE room_id=? ORDER BY id DESC LIMIT 40';
   const [messages,members,activityRows,blockedRows,reactionRows]=await Promise.all([db.prepare(messageSql).bind(id).all(),db.prepare('SELECT m.visitor_id,m.display_name,m.last_seen,CASE WHEN a.visitor_id IS NULL THEN 0 ELSE 1 END AS is_admin,CASE WHEN z.visitor_id IS NULL THEN 0 ELSE 1 END AS muted FROM members m LEFT JOIN room_admins a ON a.room_id=m.room_id AND a.visitor_id=m.visitor_id LEFT JOIN muted z ON z.room_id=m.room_id AND z.visitor_id=m.visitor_id WHERE m.room_id=? ORDER BY m.joined_at').bind(id).all(),isAdmin?db.prepare(activitySql).bind(id).all():Promise.resolve({results:[]}),master?db.prepare('SELECT visitor_id,created_at FROM blocked WHERE room_id=? ORDER BY created_at DESC').bind(id).all():Promise.resolve({results:[]}),db.prepare('SELECT message_id,emoji,COUNT(*) AS count FROM message_reactions WHERE room_id=? GROUP BY message_id,emoji').bind(id).all()]);
   return json({room:safeRoom(room,(members.results||[]).length),member:{displayName:m?.display_name||'',role:isAdmin?'admin':'member',isCreator:room.creator_id===v||!!account&&room.creator_account_id===account.id,isMaster:master},messages:(messages.results||[]).reverse().map(x=>({id:x.id,senderId:x.sender_id,displayName:x.display_name,kind:x.kind,text:x.text,gifUrl:x.gif_url,createdAt:x.created_at,editedAt:x.edited_at||null,replyToId:x.reply_to_id||null,reactions:(reactionRows.results||[]).filter(r=>r.message_id===x.id).map(r=>({emoji:r.emoji,count:r.count})),role:x.is_admin?'admin':'member'})),members:(members.results||[]).map(x=>({visitorId:x.visitor_id,displayName:x.display_name,lastSeen:x.last_seen,role:x.is_admin||(isAdmin&&x.visitor_id===v)?'admin':'member',muted:!!x.muted,isCreator:x.visitor_id===room.creator_id})),activity:(activityRows.results||[]).reverse(),blocked:(blockedRows.results||[]).map(x=>({visitorId:x.visitor_id,createdAt:x.created_at}))});
  }
  if(path.length===3&&path[2]==='join'&&method==='POST'){
   const b=await request.json(),v=visitor(request),credential=request.headers.get('X-Admin-Key')||'',joinMaster=master||!!env.MASTER_ADMIN_CODE&&credential===env.MASTER_ADMIN_CODE;if(!v)return fail('Browser identity is missing.');
   let credentialIsAdmin=false;if(!master&&!joinMaster&&credential){const adminRow=await db.prepare('SELECT key_hash FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,v).first();credentialIsAdmin=!!adminRow&&await digest(credential)===adminRow.key_hash}
   if(joinMaster){await db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,v).run();return json({room:safeRoom(room),member:{displayName:'Master Admin',role:'admin',isCreator:false,isMaster:true},masterConsole:true})}
   if(!joinMaster&&await db.prepare('SELECT 1 FROM blocked WHERE room_id=? AND visitor_id=?').bind(id,v).first())return fail('You are blocked from this room.',403);
   const existing=await member(db,request,id);
   if(!existing&&!joinMaster&&!credentialIsAdmin&&room.password_hash){const attemptId=await digest(request.headers.get('CF-Connecting-IP')||v),tries=await db.prepare('SELECT COUNT(*) n FROM join_attempts WHERE room_id=? AND visitor_id=? AND created_at>?').bind(id,attemptId,now()-900000).first();if((tries?.n||0)>=5)return fail('Too many password attempts. Try again in 15 minutes.',429);const h=await passwordHash(trim(b.password,64),room.password_salt);if(h!==room.password_hash){await db.prepare('INSERT INTO join_attempts(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,attemptId,now()).run();return fail('Incorrect room or admin password.',403)}}
   if(!existing){const account=await currentAccount(db,request),anonymous=!!b.anonymous&&!room.password_hash&&!account,dn=account?.username||(anonymous?await reserveAnonymousName(db,id,v):trim(b.displayName,24)||'Friendly Guest');await db.prepare('INSERT INTO members(room_id,visitor_id,display_name,joined_at,last_seen) VALUES(?,?,?,?,?)').bind(id,v,dn,now(),now()).run();await activity(db,id,`${dn} joined the room`);await roomEvent(db,id,`${dn} joined the room`)}else await db.prepare('UPDATE members SET last_seen=? WHERE room_id=? AND visitor_id=?').bind(now(),id,v).run();
   const isAdmin=await admin(db,request,id,env)||joinMaster,m=await member(db,request,id);return json({room:await publicRoom(db,id),member:{displayName:m.display_name,role:isAdmin?'admin':'member',isCreator:room.creator_id===v,isMaster:joinMaster}});
  }
  if(path.length===3&&path[2]==='leave'&&method==='POST'){const v=visitor(request),m=await member(db,request,id);if(m){await db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,v).run();await activity(db,id,`${m.display_name} left the room`);await roomEvent(db,id,`${m.display_name} left the room`)}return json({ok:true})}
  if(path.length===3&&path[2]==='messages'&&method==='POST'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);if(await db.prepare('SELECT 1 FROM muted WHERE room_id=? AND visitor_id=?').bind(id,v).first())return fail('You are muted in this room. You can still read messages.',403);
   const clientIp=request.headers.get('CF-Connecting-IP')||v;
   if(!await consumeRateLimit(db,'message_send_room_visitor',`${id}:${v}`,30,60*1000,id))return json({error:'You are sending messages too quickly. Please wait a minute and try again.'},429);
   if(!await consumeRateLimit(db,'message_send_room_ip',`${id}:${clientIp}`,90,60*1000,id))return json({error:'Too many messages from this network in this room. Please wait a minute and try again.'},429);
   const b=await request.json(),kind=b.kind==='gif'?'gif':'text',text=trim(b.text,255);if(kind==='text'&&!text)return fail('Message cannot be empty.');let gif='';if(kind==='gif'){try{const u=new URL(String(b.gifUrl||''));if(u.protocol!=='https:'||u.href.length>500)throw 0;gif=u.href}catch{return fail('GIF URL must be a valid HTTPS link under 500 characters.')}}
   const replyToId=Number(b.replyToId)||null;if(replyToId){const parent=await db.prepare('SELECT id FROM messages WHERE id=? AND room_id=? AND kind!=\'event\'').bind(replyToId,id).first();if(!parent)return fail('Reply target not found.',404)}await db.prepare('INSERT INTO messages(room_id,sender_id,display_name,kind,text,gif_url,created_at,reply_to_id) VALUES(?,?,?,?,?,?,?,?)').bind(id,v,m.display_name,kind,text,gif,now(),replyToId).run();const adminTagged=kind==='text'&&/(^|\s)@admin\b/i.test(text);if(adminTagged){await activity(db,id,`${m.display_name} tagged @admin`);await roomEvent(db,id,`${m.display_name} tagged @admin - room admins, please review`)}const creatorTagged=kind==='text'&&/(^|\s)@creator\b/i.test(text),creatorAlert=creatorTagged?await sendCreatorTelegram(db,env,request,id,room,m.display_name,text):'none';return json({ok:true,creatorAlert},201);
  }
  if(path.length===4&&path[2]==='messages'&&method==='PATCH'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);const mid=Number(path[3]),row=await db.prepare('SELECT sender_id,kind FROM messages WHERE id=? AND room_id=?').bind(mid,id).first();if(!row||row.kind==='event')return fail('Message not found.',404);if(row.sender_id!==v)return fail('You can edit only your own messages.',403);const b=await request.json(),text=trim(b.text,255);if(!text)return fail('Message cannot be empty.');await db.prepare("UPDATE messages SET text=?,edited_at=? WHERE id=? AND room_id=?").bind(text,now(),mid,id).run();return json({ok:true});
  }
  if(path.length===4&&path[2]==='messages'&&method==='DELETE'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);const mid=Number(path[3]),row=await db.prepare('SELECT sender_id,kind FROM messages WHERE id=? AND room_id=?').bind(mid,id).first();if(!row)return fail('Message not found.',404);if(row.sender_id!==v&&!await admin(db,request,id,env))return fail('You can delete only your own messages.',403);await db.prepare('DELETE FROM messages WHERE id=? AND room_id=?').bind(mid,id).run();await activity(db,id,`${m.display_name} deleted a message`);return json({ok:true});
  }
  if(path.length===5&&path[2]==='messages'&&path[4]==='reactions'&&method==='POST'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);const mid=Number(path[3]),b=await request.json(),emoji=String(b.emoji||'');if(!['👍','❤️','😂','😮','😢','🎉'].includes(emoji))return fail('Unsupported reaction.');const exists=await db.prepare('SELECT 1 FROM messages WHERE id=? AND room_id=? AND kind!=\'event\'').bind(mid,id).first();if(!exists)return fail('Message not found.',404);const current=await db.prepare('SELECT 1 FROM message_reactions WHERE message_id=? AND visitor_id=? AND emoji=?').bind(mid,v,emoji).first();if(current)await db.prepare('DELETE FROM message_reactions WHERE message_id=? AND visitor_id=? AND emoji=?').bind(mid,v,emoji).run();else await db.prepare('INSERT INTO message_reactions(room_id,message_id,visitor_id,emoji,created_at) VALUES(?,?,?,?,?)').bind(id,mid,v,emoji,now()).run();return json({ok:true});
  }
  if(path.length===3&&path[2]==='typing'&&method==='GET'){const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);const rows=await db.prepare('SELECT display_name FROM typing WHERE room_id=? AND visitor_id!=? AND updated_at>? ORDER BY updated_at DESC LIMIT 5').bind(id,v,now()-8000).all();return json({typing:(rows.results||[]).map(x=>x.display_name)});}
  if(path.length===3&&path[2]==='typing'&&method==='POST'){
   const v=visitor(request),m=await member(db,request,id);if(!m)return fail('Join this room first.',403);const b=await request.json();if(b.typing)await db.prepare('INSERT OR REPLACE INTO typing(room_id,visitor_id,display_name,updated_at) VALUES(?,?,?,?)').bind(id,v,m.display_name,now()).run();else await db.prepare('DELETE FROM typing WHERE room_id=? AND visitor_id=?').bind(id,v).run();const rows=await db.prepare('SELECT display_name FROM typing WHERE room_id=? AND visitor_id!=? AND updated_at>? ORDER BY updated_at DESC LIMIT 5').bind(id,v,now()-8000).all();return json({typing:(rows.results||[]).map(x=>x.display_name)});
  }
  if(path.length===3&&path[2]==='settings'&&method==='PATCH'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can change settings.',403);const actor=await member(db,request,id),b=await request.json(),mins=Number(b.expiresMinutes);if(!Number.isInteger(mins)||mins<1||mins>43200)return fail('Expiry must be from 1 minute to 30 days.');await db.prepare('UPDATE rooms SET name=?,description=?,rules=?,expires_at=? WHERE id=?').bind(trim(b.name,48)||room.name,trim(b.description,180),trim(b.rules,500),now()+mins*60000,id).run();await activity(db,id,`${actor?.display_name||'An admin'} updated room settings`);return json({room:await publicRoom(db,id)});
  }
  if(path.length===3&&path[2]==='password'&&method==='PUT'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can change the password.',403);const actor=await member(db,request,id),b=await request.json(),p=trim(b.password,64);if(p&&p.length<4)return fail('Password must be at least 4 characters.');const salt=p?code(16):null,hash=p?await passwordHash(p,salt):null;await db.prepare('UPDATE rooms SET password_salt=?,password_hash=? WHERE id=?').bind(salt,hash,id).run();await activity(db,id,`${actor?.display_name||'An admin'} ${p?'changed':'removed'} the room password`);return json({ok:true});
  }
  if(path.length===3&&path[2]==='block'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can block members.',403);const actor=await member(db,request,id),b=await request.json(),target=String(b.targetId||'');if(!target)return fail('Choose a member to block.');const blocked=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();await db.batch([db.prepare('INSERT OR IGNORE INTO blocked(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,target,now()),db.prepare('DELETE FROM members WHERE room_id=? AND visitor_id=?').bind(id,target)]);await activity(db,id,`${actor?.display_name||'An admin'} blocked ${blocked?.display_name||'a member'}`);return json({ok:true});
  }
  if(path.length===4&&path[2]==='blocked'&&method==='DELETE'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can unblock members.',403);await db.prepare('DELETE FROM blocked WHERE room_id=? AND visitor_id=?').bind(id,path[3]).run();await activity(db,id,'An admin unblocked a browser identity');return json({ok:true});
  }
  if(path.length===3&&path[2]==='admins'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can nominate admins.',403);const b=await request.json(),target=String(b.targetId||''),m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!m)return fail('That member is no longer in the room.');const key=code(8);await db.prepare('INSERT OR REPLACE INTO room_admins(room_id,visitor_id,key_hash) VALUES(?,?,?)').bind(id,target,await digest(key)).run();await activity(db,id,`${m.display_name} was made an admin`);return json({adminKey:key,displayName:m.display_name});
  }
  if(path.length===4&&path[2]==='admins'&&method==='DELETE'){
   if(!await admin(db,request,id,env))return fail('Only a room admin can change admin roles.',403);const target=decodeURIComponent(path[3]);if(target===room.creator_id)return fail('The room creator cannot be demoted.',400);const row=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!row)return fail('That member is no longer in the room.');const assigned=await db.prepare('SELECT 1 FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!assigned)return fail('That member is not an admin.');const count=await db.prepare('SELECT COUNT(*) n FROM room_admins WHERE room_id=?').bind(id).first();if((count?.n||0)<=1)return fail('The last room admin cannot be demoted.',400);await db.prepare('DELETE FROM room_admins WHERE room_id=? AND visitor_id=?').bind(id,target).run();await activity(db,id,`${row.display_name} was demoted from admin`);return json({ok:true});
  }
  if(path.length===3&&path[2]==='mute'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can mute members.',403);const b=await request.json(),target=String(b.targetId||'');if(!target)return fail('Choose a member.');const m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();if(!m)return fail('That member is not in the room.');await db.prepare('INSERT OR IGNORE INTO muted(room_id,visitor_id,created_at) VALUES(?,?,?)').bind(id,target,now()).run();await activity(db,id,`${m.display_name} was muted`);return json({ok:true});
  }
  if(path.length===3&&path[2]==='unmute'&&method==='POST'){
   if(!await admin(db,request,id,env))return fail('Only the room admin can unmute members.',403);const b=await request.json(),target=String(b.targetId||'');await db.prepare('DELETE FROM muted WHERE room_id=? AND visitor_id=?').bind(id,target).run();const m=await db.prepare('SELECT display_name FROM members WHERE room_id=? AND visitor_id=?').bind(id,target).first();await activity(db,id,`${m?.display_name||'A member'} was unmuted`);return json({ok:true});
  }
  if(path.length===2&&method==='DELETE'){
   const owner=await db.prepare('SELECT creator_id,creator_account_id FROM rooms WHERE id=?').bind(id).first(),account=await currentAccount(db,request),isCreator=owner?.creator_id===visitor(request)||!!account&&owner?.creator_account_id===account.id;
   if(!master&&(!isCreator||!await admin(db,request,id,env)))return fail('Only the room creator or the master admin can delete this room.',403);
   await db.prepare('DELETE FROM rooms WHERE id=?').bind(id).run();return json({ok:true});
  }
  return fail('Not found.',404);
 }catch(e){console.error('API request failed',e);return fail('An unexpected server error occurred. Please try again.',500)}
}


// Server-issued, signed browser identity. Client-supplied X-Visitor-Id is overwritten
// before any endpoint runs, so public member IDs cannot be used to impersonate users.
async function sessionSignature(id, secret) {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
 const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
 return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function sessionVisitor(request, secret) {
 const cookie = (request.headers.get('Cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('__Host-husky-session='));
 if (!cookie) return null;
 const token = cookie.slice('__Host-husky-session='.length);
 const dot = token.lastIndexOf('.');
 if (dot < 1) return null;
 const id = token.slice(0,dot), supplied = token.slice(dot+1);
 if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(supplied)) return null;
 const expected = await sessionSignature(id, secret);
 return constantTimeEqual(supplied, expected) ? id : null;
}
export async function onRequest({request,env}) {
 if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
  return fail('Server setup incomplete: add a SESSION_SECRET with at least 32 characters in Cloudflare Pages secrets.',503);
 }
 const id = await sessionVisitor(request, String(env.SESSION_SECRET)) || crypto.randomUUID();
 const signature = await sessionSignature(id, String(env.SESSION_SECRET));
 const headers = new Headers(request.headers);
 headers.set('X-Visitor-Id', id);
 const trustedRequest = new Request(request, {headers});
 const response = await handleRequest({request:trustedRequest,env});
 const responseHeaders = new Headers(response.headers);
 responseHeaders.set('X-Husky-Visitor-Id', id);
 responseHeaders.append('Set-Cookie', `__Host-husky-session=${id}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
 return new Response(response.body, {status:response.status,statusText:response.statusText,headers:responseHeaders});
}
