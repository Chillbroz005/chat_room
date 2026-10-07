const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();
const MAX_MINUTES = 30 * 24 * 60;
const makeId = () => crypto.randomBytes(5).toString('hex').slice(0, 6).toUpperCase();
const clean = (value, max) => String(value || '').trim().slice(0, max);
function requireAuth(request) { if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.'); return request.auth.uid; }
function roomId(data) { const id = clean(data.roomId, 6).toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(id)) throw new HttpsError('invalid-argument', 'Enter a valid 6-character room code.'); return id; }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function passwordOk(password, secret) { if (typeof password !== 'string' || password.length < 4 || password.length > 64) return false; const actual = Buffer.from(hashPassword(password, secret.salt), 'hex'); const expected = Buffer.from(secret.hash, 'hex'); return actual.length === expected.length && crypto.timingSafeEqual(actual, expected); }
function validExpiry(value) { const n=Number(value); if(!Number.isInteger(n)||n<1||n>MAX_MINUTES)throw new HttpsError('invalid-argument','Expiry must be from 1 minute to 30 days.');return n; }
async function addActivity(id, text) { await db.collection('rooms').doc(id).collection('activity').add({text,createdAt:FieldValue.serverTimestamp()}); }
async function adminMember(id, uid) { const roomRef=db.collection('rooms').doc(id),ref=roomRef.collection('members').doc(uid);const [roomSnap,snap]=await Promise.all([roomRef.get(),ref.get()]);if(!roomSnap.exists||roomSnap.data().expiresAt.toMillis()<=Date.now())throw new HttpsError('failed-precondition','This room has expired.');if(!snap.exists||snap.data().role!=='admin')throw new HttpsError('permission-denied','Only a room admin can do that.');return snap; }

exports.createRoom = onCall(async request => {
  const uid=requireAuth(request), data=request.data||{};
  const password=typeof data.password==='string'?data.password:'';
  if(password.length>64||(password.length>0&&password.length<4))throw new HttpsError('invalid-argument','A room password must be 4 to 64 characters, or left blank.');
  const minutes=validExpiry(data.expiresMinutes), now=Date.now(), expiresAt=Timestamp.fromMillis(now+minutes*60000);
  const creatorName=clean(data.creatorName,24)||'Sunny Fox', name=clean(data.name,48)||`${creatorName.split(' ')[0]}'s room`, description=clean(data.description,180);
  const hasPassword=password.length>0, salt=hasPassword?crypto.randomBytes(16).toString('hex'):null, hash=hasPassword?hashPassword(password,salt):null;
  for(let attempt=0;attempt<5;attempt++){
    const id=makeId(), roomRef=db.collection('rooms').doc(id);
    try{
      await db.runTransaction(async tx=>{
        const existing=await tx.get(roomRef);if(existing.exists)throw new HttpsError('aborted','Try again.');
        tx.create(roomRef,{name,creatorName,creatorUid:uid,createdAt:Timestamp.fromMillis(now),expiresAt,description,rules:'',hasPassword,memberCount:1});
        if(hasPassword)tx.create(db.collection('roomSecrets').doc(id),{salt,hash,updatedAt:FieldValue.serverTimestamp()});
        tx.create(roomRef.collection('members').doc(uid),{displayName:creatorName,role:'admin',joinedAt:Timestamp.fromMillis(now),online:true,lastSeen:Timestamp.fromMillis(now)});
        tx.create(roomRef.collection('activity').doc(),{text:`${creatorName} created this room.`,createdAt:Timestamp.fromMillis(now)});
        tx.create(roomRef.collection('messages').doc(),{kind:'event',text:`${creatorName} created the room.`,senderUid:'system',displayName:'Gather',createdAt:Timestamp.fromMillis(now)});
      });
      return {roomId:id,name,creatorName,createdAt:now,expiresAt:expiresAt.toMillis(),description,hasPassword,role:'admin'};
    }catch(e){if(e.code==='aborted'&&attempt<4)continue;logger.error('createRoom failed',{uid,error:e});if(e instanceof HttpsError)throw e;throw new HttpsError('internal','Room creation failed on the server. Check Firebase Console → Functions → Logs.',{cause:e.message});}
  }
  throw new HttpsError('internal','Could not create a room. Try again.');
});

// Return only non-secret, non-expired room-card fields. Room discovery never
// grants direct access to room documents, password hashes, members, or chat.
exports.listRooms = onCall(async request => {
  requireAuth(request);
  const result=await db.collection('rooms').where('expiresAt','>',Timestamp.now()).limit(100).get();
  const rooms=result.docs.map(doc=>{const r=doc.data();return {id:doc.id,name:r.name,creatorName:r.creatorName,createdAt:r.createdAt.toMillis(),expiresAt:r.expiresAt.toMillis(),description:r.description||'',memberCount:r.memberCount||0,hasPassword:r.hasPassword!==false};}).sort((a,b)=>b.createdAt-a.createdAt);
  return {rooms};
});

exports.joinRoom = onCall(async request => {
  const uid=requireAuth(request), id=roomId(request.data||{}), password=request.data.password;
  const roomRef=db.collection('rooms').doc(id), memberRef=roomRef.collection('members').doc(uid), secretRef=db.collection('roomSecrets').doc(id), attemptRef=db.collection('joinAttempts').doc(`${id}_${uid}`);
  const [roomSnap,memberSnap,secretSnap,blockedSnap,attemptSnap]=await Promise.all([roomRef.get(),memberRef.get(),secretRef.get(),roomRef.collection('blocked').doc(uid).get(),attemptRef.get()]);
  if(!roomSnap.exists||roomSnap.data().expiresAt.toMillis()<=Date.now())throw new HttpsError('not-found','This room has expired or does not exist.');
  if(blockedSnap.exists)throw new HttpsError('permission-denied','The room admin has blocked this account.');
  const needsPassword=roomSnap.data().hasPassword!==false;
  if(needsPassword&&attemptSnap.exists&&attemptSnap.data().blockedUntil?.toMillis?.()>Date.now())throw new HttpsError('resource-exhausted','Too many incorrect passwords. Try again in 15 minutes.');
  if(needsPassword&&(!secretSnap.exists||!passwordOk(password,secretSnap.data()))){
    const now=Date.now(),attempt=attemptSnap.data()||{},sameWindow=attempt.windowStart&&now-attempt.windowStart.toMillis()<15*60*1000,count=sameWindow?attempt.count+1:1;
    await attemptRef.set({count,windowStart:sameWindow?attempt.windowStart:Timestamp.fromMillis(now),blockedUntil:count>=5?Timestamp.fromMillis(now+15*60*1000):null});
    throw new HttpsError('permission-denied','That room password is incorrect.');
  }
  if(needsPassword&&attemptSnap.exists)await attemptRef.delete();
  const displayName=clean(request.data.displayName,24)||'Sunny Fox';
  if(memberSnap.exists){await memberRef.update({online:true,lastSeen:FieldValue.serverTimestamp()});return {roomId:id,displayName:memberSnap.data().displayName,role:memberSnap.data().role};}
  await db.runTransaction(async tx=>{
    const fresh=await tx.get(roomRef);if(!fresh.exists||fresh.data().expiresAt.toMillis()<=Date.now())throw new HttpsError('not-found','This room has expired.');
    const blocked=await tx.get(roomRef.collection('blocked').doc(uid));if(blocked.exists)throw new HttpsError('permission-denied','The room admin has blocked this account.');
    const role=fresh.data().creatorUid===uid?'admin':'member';
    tx.create(memberRef,{displayName,role,joinedAt:FieldValue.serverTimestamp(),online:true,lastSeen:FieldValue.serverTimestamp()});
    tx.update(roomRef,{memberCount:FieldValue.increment(1)});
    tx.create(roomRef.collection('activity').doc(),{text:`${displayName} joined the room.`,createdAt:FieldValue.serverTimestamp()});
    tx.create(roomRef.collection('messages').doc(),{kind:'event',text:`${displayName} joined the room.`,senderUid:'system',displayName:'Gather',createdAt:FieldValue.serverTimestamp()});
  });
  return {roomId:id,displayName,role:roomSnap.data().creatorUid===uid?'admin':'member'};
});

exports.leaveRoom = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{}),ref=db.collection('rooms').doc(id),memberRef=ref.collection('members').doc(uid);const member=await memberRef.get();
  if(!member.exists)return {ok:true};const name=member.data().displayName;
  await db.runTransaction(async tx=>{const [current,roomSnap]=await Promise.all([tx.get(memberRef),tx.get(ref)]);if(!current.exists||!roomSnap.exists)return;const latestName=current.data().displayName;tx.delete(memberRef);tx.update(ref,{memberCount:FieldValue.increment(-1)});tx.create(ref.collection('activity').doc(),{text:`${latestName} left the room.`,createdAt:FieldValue.serverTimestamp()});tx.create(ref.collection('messages').doc(),{kind:'event',text:`${latestName} left the room.`,senderUid:'system',displayName:'Gather',createdAt:FieldValue.serverTimestamp()});});return {ok:true};
});

exports.updateRoom = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{});await adminMember(id,uid);
  const minutes=validExpiry(request.data.expiresMinutes),ref=db.collection('rooms').doc(id),snap=await ref.get();if(!snap.exists)throw new HttpsError('not-found','Room not found.');
  if(snap.data().expiresAt.toMillis()<=Date.now())throw new HttpsError('failed-precondition','This room has expired.');
  const expiresAt=Timestamp.fromMillis(Date.now()+minutes*60000),name=clean(request.data.name,48)||'Gather room',description=clean(request.data.description,180),rules=clean(request.data.rules,500);
  await ref.update({name,description,rules,expiresAt});await addActivity(id,'Room settings were updated.');return {name,description,rules,expiresAtMillis:expiresAt.toMillis()};
});

exports.setRoomPassword = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{}),password=request.data.password;await adminMember(id,uid);
  if(typeof password!=='string'||password.length>64||(password.length>0&&password.length<4))throw new HttpsError('invalid-argument','Password must be 4 to 64 characters, or blank to remove it.');
  const roomRef=db.collection('rooms').doc(id),secretRef=db.collection('roomSecrets').doc(id);
  if(password.length===0){await secretRef.delete();await roomRef.update({hasPassword:false});await addActivity(id,'Room password removed.');return {ok:true,hasPassword:false};}
  const salt=crypto.randomBytes(16).toString('hex');await secretRef.set({salt,hash:hashPassword(password,salt),updatedAt:FieldValue.serverTimestamp()});await roomRef.update({hasPassword:true});await addActivity(id,'Room password changed.');return {ok:true,hasPassword:true};
});

exports.blockUser = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{}),target=clean(request.data.targetUid,128);await adminMember(id,uid);
  if(!target||target===uid)throw new HttpsError('invalid-argument','Choose another member.');const ref=db.collection('rooms').doc(id),memberRef=ref.collection('members').doc(target),member=await memberRef.get();if(!member.exists)throw new HttpsError('not-found','Member not found.');
  await db.runTransaction(async tx=>{const [current,roomSnap]=await Promise.all([tx.get(memberRef),tx.get(ref)]);if(!roomSnap.exists)throw new HttpsError('not-found','Room not found.');tx.set(ref.collection('blocked').doc(target),{blockedAt:FieldValue.serverTimestamp(),blockedBy:uid});if(current.exists){const name=current.data().displayName;tx.delete(memberRef);tx.update(ref,{memberCount:FieldValue.increment(-1)});tx.create(ref.collection('activity').doc(),{text:`${name} was blocked by the host.`,createdAt:FieldValue.serverTimestamp()});tx.create(ref.collection('messages').doc(),{kind:'event',text:`${name} was removed by the host.`,senderUid:'system',displayName:'Gather',createdAt:FieldValue.serverTimestamp()});}});return {ok:true};
});

exports.promoteAdmin = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{}),target=clean(request.data.targetUid,128);await adminMember(id,uid);
  const ref=db.collection('rooms').doc(id),memberRef=ref.collection('members').doc(target),member=await memberRef.get();if(!member.exists)throw new HttpsError('not-found','Member not found.');
  await memberRef.update({role:'admin'});await addActivity(id,`${member.data().displayName} was made an admin.`);return {ok:true};
});

exports.deleteMessage = onCall(async request => {
  const uid=requireAuth(request),id=roomId(request.data||{}),messageId=clean(request.data.messageId,128);await adminMember(id,uid);
  if(!messageId)throw new HttpsError('invalid-argument','Message ID required.');const ref=db.collection('rooms').doc(id),msgRef=ref.collection('messages').doc(messageId),snap=await msgRef.get();if(!snap.exists)throw new HttpsError('not-found','Message not found.');if(snap.data().kind==='event')throw new HttpsError('failed-precondition','Room activity messages cannot be deleted.');
  await msgRef.delete();await addActivity(id,`A message from ${clean(snap.data().displayName,24)} was deleted by the host.`);return {ok:true};
});

// Expired rooms stop accepting reads/writes immediately via Firestore rules.
// This scheduled cleanup permanently removes rooms and their nested data.
exports.removeExpiredRooms = onSchedule('every 24 hours', async () => {
  const expired=await db.collection('rooms').where('expiresAt','<=',Timestamp.now()).limit(100).get();
  for(const doc of expired.docs) await db.recursiveDelete(doc.ref);
});
