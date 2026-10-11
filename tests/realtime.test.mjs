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
