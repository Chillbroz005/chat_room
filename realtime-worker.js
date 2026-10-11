export class RoomRealtime {
 constructor(state, env) { this.state = state; this.env = env; }
 async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/publish' && request.method === 'POST') {
   const expected = String(this.env.REALTIME_PUBLISH_SECRET || '');
   const supplied = request.headers.get('x-husky-publish-secret') || '';
   if (!expected || !constantTimeEqual(expected, supplied)) return new Response('Forbidden', {status:403});
   let event;
   try { event = await request.json(); } catch { return new Response('Bad Request', {status:400}); }
   const payload = JSON.stringify({type:'invalidate', roomId:String(event.roomId || '')});
   let delivered = 0;
   for (const socket of this.state.getWebSockets()) {
    try { socket.send(payload); delivered++; } catch { try { socket.close(1011, 'Delivery failed'); } catch {} }
   }
   return Response.json({ok:true,delivered});
  }
  if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
   const pair = new WebSocketPair();
   const client = pair[0], server = pair[1];
   this.state.acceptWebSocket(server);
   server.send(JSON.stringify({type:'ready'}));
   return new Response(null, {status:101, webSocket:client});
  }
  return new Response('Not Found', {status:404});
 }
 webSocketMessage(socket, message) { if (message === 'ping') { try { socket.send('pong'); } catch {} } }
 webSocketClose(socket) { try { socket.close(); } catch {} }
 webSocketError(socket) { try { socket.close(1011, 'Socket error'); } catch {} }
}
function constantTimeEqual(a,b) {
 if (a.length !== b.length) return false;
 let diff = 0;
 for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
 return diff === 0;
}
export default { async fetch() { return new Response('Not Found', {status:404}); } };
