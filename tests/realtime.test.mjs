import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../realtime-worker.js', import.meta.url), 'utf8');

test('client has no recurring polling timers for rooms or room data', () => {
  assert.doesNotMatch(app, /setInterval\s*\(/);
  assert.doesNotMatch(app, /pollTimer/);
  assert.match(app, /new WebSocket/);
  assert.match(app, /connectLive\(result\.room\.id/);
});

test('Pages API authorizes room sockets and forwards WebSocket upgrades', () => {
  assert.match(api, /path\[0\]==='live'/);
  assert.match(api, /path\[2\]==='live'/);
  assert.match(api, /Join this room first\.',403/);
  assert.match(api, /if\(response\.status===101\)return response/);
});

test('successful mutations publish invalidation events through the Durable Object binding', () => {
  assert.match(api, /env\.REALTIME\.get\(env\.REALTIME\.idFromName\(roomId\)\)/);
  assert.match(api, /x-husky-publish-secret/);
  assert.match(worker, /this\.state\.getWebSockets\(\)/);
  assert.match(worker, /constantTimeEqual\(expected, supplied\)/);
});


test('Telegram replies publish a room invalidation for connected WebSocket clients', () => {
  assert.match(api, /parts\[0\]==='telegram-webhook'&&request\.method==='POST'/);
  assert.match(api, /request\.clone\(\)\.json\(\)/);
  assert.match(api, /targets\.push\(roomId\)/);
});

test('room header displays the active username and invite opens the share dialog', async () => {
  assert.match(app, /current-room-username/);
  assert.match(app, /\$\('copy-invite'\)\.onclick=\(\)=>\{if\(!activeRoom/);
  assert.match(app, /openRoomShare\(activeRoom\)/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="current-room-username"/);
});


test('Telegram reply parser accepts creator alerts, explicit commands, and plain-text fallback', () => {
  assert.match(api, /function parseTelegramReply\(message,fallbackRoomId=''/);
  assert.match(api, /\^\\@creator mention in \[\\s\\S\]\*\?\\\(\[A-Z0-9\]\{6\}\)\\s\+From:/);
  assert.match(api, /\/reply\(\?:@\\w\+\)\?\\s\+\(\[A-Z0-9\]\{6\}\)\\s\+/);
  assert.match(api, /if\(fallbackRoomId\)return \{roomId:fallbackRoomId,text\}/);
});

test('Telegram webhook explains creator ID mismatch instead of silently dropping replies', () => {
  assert.match(api, /TELEGRAM_CREATOR_USER_ID does not match your Telegram numeric user ID/);
});

test('plain Telegram replies publish realtime invalidation for the most recently alerted active room', () => {
  assert.match(api, /a\.text='@creator Telegram alert sent'/);
  assert.match(api, /if\(!roomId&&text&&!text\.startsWith\('\/'\)/);
});
