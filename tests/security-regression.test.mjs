import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('authentication throttling, generic errors, and password policy remain present', async () => {
  const api = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
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
