import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

const secret = 'test-only-session-secret-at-least-32-characters';

test('runtime: missing SESSION_SECRET fails closed before handling requests', async () => {
  const response = await onRequest({
    request: new Request('https://example.test/api/account'),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Server setup incomplete/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('runtime: valid configuration issues a signed HttpOnly Secure session cookie', async () => {
  const response = await onRequest({
    request: new Request('https://example.test/api/account', {
      headers: { 'X-Visitor-Id': 'attacker-controlled-id' }
    }),
    env: { SESSION_SECRET: secret }
  });
  // The DB binding is intentionally absent: this checks the real handler's fail-closed path.
  assert.equal(response.status, 503);
  const cookie = response.headers.get('set-cookie') || '';
  assert.match(cookie, /__Host-husky-session=[0-9a-f-]{36}\.[0-9a-f]{64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const issuedId = response.headers.get('X-Husky-Visitor-Id');
  assert.ok(issuedId);
  assert.notEqual(issuedId, 'attacker-controlled-id');
});

test('runtime: malformed session cookie is replaced with a fresh signed identity', async () => {
  const response = await onRequest({
    request: new Request('https://example.test/api/account', {
      headers: { Cookie: '__Host-husky-session=not-a-valid-session' }
    }),
    env: { SESSION_SECRET: secret }
  });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('set-cookie') || '', /__Host-husky-session=[0-9a-f-]{36}\.[0-9a-f]{64}/);
  assert.notEqual(response.headers.get('X-Husky-Visitor-Id'), 'not-a-valid-session');
});
