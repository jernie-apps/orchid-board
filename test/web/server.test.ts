import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Secret } from '../../src/secrets.ts';
import { openStore } from '../../src/store/store.ts';
import type { SyncEvents } from '../../src/sync/poller.ts';
import { LoginLimiter, passphraseMatches, startWebServer } from '../../src/web/server.ts';

const REPO = 'companie-apps/orchid-board';
const PASSPHRASE = 'correct horse battery staple';

async function fixture(t: TestContext) {
  const store = openStore(':memory:');
  store.upsertIssues([
    { ref: `${REPO}#1`, nodeId: 'n1', type: 'Phase', title: 'Orchid Board v1', state: 'open', parent: null, iteration: null, updatedAt: '2026-11-18T00:00:00Z' },
    { ref: `${REPO}#10`, nodeId: 'n10', type: 'Task', title: 'web-board <b>x</b>', state: 'open', parent: `${REPO}#1`, iteration: null, updatedAt: '2026-11-18T00:00:00Z' },
  ]);
  const sync = { events: new EventEmitter<SyncEvents>(), lastSyncAt: null as number | null };
  const server = await startWebServer({ store, sync, passphrase: new Secret('web.passphrase', PASSPHRASE), port: 0, mcpPort: 4311 });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const login = (passphrase: string, headers: Record<string, string> = {}) =>
    request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ passphrase }).toString(),
    });
  const session = async () => {
    const res = await login(PASSPHRASE);
    assert.equal(res.status, 303);
    const cookie = res.headers.get('set-cookie') ?? '';
    return cookie.split(';')[0]!;
  };
  return { server, sync, store, request, login, session };
}

test('passphrase compare is exact', () => {
  const secret = new Secret('web.passphrase', PASSPHRASE);
  assert.equal(passphraseMatches(PASSPHRASE, secret), true);
  assert.equal(passphraseMatches(`${PASSPHRASE} `, secret), false);
  assert.equal(passphraseMatches('', secret), false);
});

test('every route but login and its stylesheet needs a session', async t => {
  const { request } = await fixture(t);
  const home = await request('/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await request('/?status=failed')).status, 303);
  for (const path of ['/fragment', '/events', '/board.js', '/nope']) {
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal((await request('/logout', { method: 'POST' })).status, 401);
  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /name="passphrase"/);
  assert.equal((await request('/board.css')).status, 200);
});

test('responses carry CSP and hardening headers', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/login', '/fragment', '/board.css']) {
    const res = await request(path);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('wrong passphrase is refused; the right one sets a hardened session cookie', async t => {
  const { request, login } = await fixture(t);
  const wrong = await login('nope');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.match(await wrong.text(), /Wrong passphrase/);

  const ok = await login(PASSPHRASE);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const cookie = ok.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^orchid_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);

  const page = await request('/', { headers: { cookie: cookie.split(';')[0]! } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('web-board &#60;b&#62;x&#60;/b&#62;'));
  assert.ok(!html.includes('<b>x</b>'));

  assert.equal((await request('/', { headers: { cookie: 'orchid_session=forged' } })).status, 303);
});

test('failed logins are rate limited per client', async t => {
  const { login } = await fixture(t);
  const alice = { 'x-forwarded-for': '192.168.1.20' };
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong', alice)).status, 401);
  // Blocked before the passphrase is checked, even when it is right.
  const blocked = await login(PASSPHRASE, alice);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('set-cookie'), null);
  // Caddy appends the real client last; a spoofed first hop does not dodge the limit.
  assert.equal((await login(PASSPHRASE, { 'x-forwarded-for': '10.0.0.1, 192.168.1.20' })).status, 429);
  assert.equal((await login(PASSPHRASE, { 'x-forwarded-for': '192.168.1.21' })).status, 303);
});

test('LoginLimiter forgets failures after the window', () => {
  const limiter = new LoginLimiter(2, 60_000);
  limiter.fail('a', 0);
  limiter.fail('a', 1_000);
  assert.equal(limiter.blocked('a', 2_000), true);
  assert.equal(limiter.blocked('b', 2_000), false);
  assert.equal(limiter.blocked('a', 61_001), false);
});

test('logout ends the session', async t => {
  const { request, session } = await fixture(t);
  const cookie = await session();
  const out = await request('/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/login');
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await request('/fragment', { headers: { cookie } })).status, 401);
});

test('fragment applies filters from the query', async t => {
  const { request, session } = await fixture(t);
  const cookie = await session();
  const all = await (await request('/fragment', { headers: { cookie } })).text();
  assert.ok(all.startsWith('<div id="app"'));
  assert.ok(all.includes(`data-ref="${REPO}#10"`));
  const failed = await (await request('/fragment?status=failed', { headers: { cookie } })).text();
  assert.ok(!failed.includes(`data-ref="${REPO}#10"`));
  assert.ok(failed.includes('Nothing matches these filters.'));
});

test('SSE pushes poller changes and sync times', async t => {
  const { request, session, sync } = await fixture(t);
  const cookie = await session();
  const res = await request('/events', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${needle}`);
      text += decoder.decode(value, { stream: true });
    }
  };
  await until('retry: 5000');
  sync.events.emit('change', { repo: REPO, issues: [`${REPO}#10`], prs: [] });
  await until('event: change\ndata: {}\n\n');
  sync.events.emit('synced', 1_795_000_000_000);
  await until('event: synced\ndata: 1795000000000\n\n');
  await reader.cancel();
});

test('close ends open SSE streams and stops listening to the poller', async t => {
  const { server, request, session, sync } = await fixture(t);
  const cookie = await session();
  const res = await request('/events', { headers: { cookie } });
  const reader = res.body!.getReader();
  await reader.read();
  assert.equal(sync.events.listenerCount('change'), 1);
  await server.close();
  assert.equal(sync.events.listenerCount('change'), 0);
  let done = false;
  while (!done) ({ done } = await reader.read().catch(() => ({ done: true, value: undefined })));
});
