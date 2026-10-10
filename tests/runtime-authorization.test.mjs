import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

const secret = 'runtime-test-session-secret-at-least-32-characters-long';

function mockDb() {
  const calls = [];
  const db = {
    withSession() { return this; },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { calls.push({ method: 'first', sql, args }); return null; },
            async all() { calls.push({ method: 'all', sql, args }); return { results: [] }; },
            async run() { calls.push({ method: 'run', sql, args }); return { meta: { changes: 0 } }; }
          };
        }
      };
    },
    async batch() { return []; }
  };
  return { db, calls };
}

test('runtime authorization: anonymous visitor cannot change room settings', async () => {
  const { db, calls } = mockDb();
  const response = await onRequest({
    request: new Request('https://example.test/api/ABC234/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'X-Visitor-Id': 'forged-admin' },
      body: JSON.stringify({ name: 'Attacker rename' })
    }),
    env: { SESSION_SECRET: secret, DB: db }
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Only the room admin can change settings/);
  assert.equal(calls.some(c => c.method === 'run' && /UPDATE rooms SET name/.test(c.sql)), false);
});

test('runtime authorization: anonymous visitor cannot delete a room', async () => {
  const { db, calls } = mockDb();
  const response = await onRequest({
    request: new Request('https://example.test/api/ABC234', {
      method: 'DELETE',
      headers: { 'X-Visitor-Id': 'forged-creator' }
    }),
    env: { SESSION_SECRET: secret, DB: db }
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Only the room creator or the master admin/);
  assert.equal(calls.some(c => c.method === 'run' && /^DELETE FROM rooms WHERE id=/.test(c.sql)), false);
});

test('runtime authorization: non-member cannot post messages', async () => {
  const { db } = mockDb();
  const response = await onRequest({
    request: new Request('https://example.test/api/ABC234/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Visitor-Id': 'not-a-member' },
      body: JSON.stringify({ text: 'unauthorized message' })
    }),
    env: { SESSION_SECRET: secret, DB: db }
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Join this room first/);
});
