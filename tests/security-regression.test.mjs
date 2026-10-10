import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

test('authentication throttling, generic errors, and password policy remain present', () => {
  assert.match(api, /account_auth_attempts/);
  assert.match(api, /Too many sign-in attempts/);
  assert.match(api, /An unexpected server error occurred/);
  assert.match(api, /Room passwords must be at least 8 characters/);
  assert.doesNotMatch(api, /return fail\(e\?\.message\|\|'Server error\.'/);
});

test('static security headers include a restrictive baseline CSP', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
});

test('client room password validation matches the API minimum', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /password\.length<8/);
  assert.match(app, /Room passwords must be at least 8 characters/);
});

test('API fails closed when SESSION_SECRET is missing or too short', () => {
  assert.match(api, /!env\.SESSION_SECRET/);
  assert.match(api, /SESSION_SECRET\)\.length < 32/);
  assert.match(api, /Server setup incomplete/);
});

test('browser sessions are signed and use secure cookie attributes', () => {
  assert.match(api, /name:'HMAC',hash:'SHA-256'/);
  assert.match(api, /constantTimeEqual\(supplied, expected\)/);
  assert.match(api, /HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
});

test('account passwords use PBKDF2 with 100000 iterations', () => {
  assert.match(api, /iterations:100000,hash:'SHA-256'/);
});

test('room creation and message posting retain visitor and IP rate limits', () => {
  assert.match(api, /room_create_visitor',v,5,15\*60\*1000/);
  assert.match(api, /room_create_ip',clientIp,10,15\*60\*1000/);
  assert.match(api, /message_send_room_visitor',[\s\S]*?30,60\*1000,id/);
  assert.match(api, /message_send_room_ip',[\s\S]*?90,60\*1000,id/);
});

test('message posting requires membership and rejects muted members', () => {
  assert.match(api, /Join this room first\.',403\);if\(await db\.prepare\('SELECT 1 FROM muted/);
});

test('room settings and deletion retain authorization checks', () => {
  assert.match(api, /Only the room admin can change settings/);
  assert.match(api, /Only the room creator or the master admin can delete this room/);
});

test('database queries use bound parameters', () => {
  assert.match(api, /\.prepare\('[^']*\?[^']*'\)\.bind\(/);
});
