import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Secret } from '../../src/secrets.ts';
import type { WriteStatus } from '../../src/proposals/writer.ts';
import { openStore } from '../../src/store/store.ts';
import type { SyncEvents } from '../../src/sync/poller.ts';
import type { InboxWriter } from '../../src/web/inbox.ts';
import { LoginLimiter, passphraseMatches, startWebServer } from '../../src/web/server.ts';

const REPO = 'companie-apps/orchid-board';
const PASSPHRASE = 'correct horse battery staple';

async function fixture(t: TestContext, writer?: InboxWriter) {
  const store = openStore(':memory:');
  store.upsertIssues([
    { ref: `${REPO}#1`, nodeId: 'n1', type: 'Phase', title: 'Orchid Board v1', state: 'open', parent: null, iteration: null, updatedAt: '2026-11-18T00:00:00Z' },
    { ref: `${REPO}#10`, nodeId: 'n10', type: 'Task', title: 'web-board <b>x</b>', state: 'open', parent: `${REPO}#1`, iteration: null, updatedAt: '2026-11-18T00:00:00Z' },
  ]);
  const sync = { events: new EventEmitter<SyncEvents>(), lastSyncAt: null as number | null };
  const server = await startWebServer({
    store, sync, passphrase: new Secret('web.passphrase', PASSPHRASE), port: 0, mcpPort: 4311, ...(writer ? { writer } : {}),
  });
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
  /** Session cookie plus the CSRF token the pages embed for it. */
  const authed = async () => {
    const cookie = await session();
    const html = await (await request('/inbox', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf, 'page embeds a CSRF token');
    const post = (path: string, fields: [string, string][]) =>
      request(path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    return { cookie, csrf, post, get: (path: string) => request(path, { headers: { cookie } }) };
  };
  return { server, sync, store, request, login, session, authed };
}

/** Phase → Feature (two Tasks) + a second Feature, proposed by Claude. */
function propose(store: ReturnType<typeof openStore>, title = 'Orchid Board v2') {
  return store.createProposal({
    agent: 'Claude',
    nodes: [
      { key: 'p', repo: REPO, type: 'Phase', title },
      { key: 'f1', parentKey: 'p', repo: REPO, type: 'Feature', title: 'board-polish', branch: 'feature/board-polish/board-polish' },
      { key: 't1', parentKey: 'f1', repo: REPO, type: 'Task', title: 'dark-theme', branch: 'feature/board-polish/dark-theme' },
      { key: 't2', parentKey: 'f1', repo: REPO, type: 'Task', title: 'keyboard-nav', branch: 'feature/board-polish/keyboard-nav' },
      { key: 'f2', parentKey: 'p', repo: REPO, type: 'Feature', title: 'notify', branch: 'feature/notify/notify' },
      { key: 't3', parentKey: 'f2', repo: REPO, type: 'Task', title: 'phone-push', branch: 'feature/notify/phone-push' },
    ],
  });
}

function fakeWriter(status: Partial<WriteStatus> = {}) {
  const kicked: string[] = [];
  const writer: InboxWriter = {
    kick: async (id: string) => {
      kicked.push(id);
    },
    status: () => ({ running: false, error: null, warnings: [], failures: 0, retryAt: null, updatedAt: null, ...status }),
  };
  return { writer, kicked };
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
  for (const path of ['/inbox', '/inbox/prop_abc']) {
    const res = await request(path);
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get('location'), '/login', path);
  }
  assert.equal((await request('/logout', { method: 'POST' })).status, 401);
  assert.equal((await request('/inbox/prop_abc', { method: 'POST' })).status, 401);
  assert.equal((await request('/inbox/prop_abc/send-back', { method: 'POST' })).status, 401);
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
  const { request, authed } = await fixture(t);
  const { cookie, csrf, post } = await authed();
  assert.equal((await post('/logout', [])).status, 403);
  const out = await post('/logout', [['csrf', csrf]]);
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

test('board header links the inbox with the pending count', async t => {
  const { store, authed } = await fixture(t);
  const { get } = await authed();
  assert.match(await (await get('/')).text(), /<a class="btn inbox-link" href="\/inbox">Inbox<\/a>/);
  propose(store);
  const html = await (await get('/fragment')).text();
  assert.match(html, /href="\/inbox" aria-label="Inbox, 1 waiting">Inbox<span class="pill">1<\/span>/);
  assert.match(html, /<form method="post" action="\/logout"><input type="hidden" name="csrf"/);
});

test('inbox lists pending proposals and escapes agent text', async t => {
  const { store, authed } = await fixture(t);
  const id = propose(store, 'v2 <img src=x onerror=alert(1)>').id;
  const { get } = await authed();
  const res = await get('/inbox');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Waiting for you · 1'));
  assert.ok(html.includes(`href="/inbox/${id}" aria-current="page"`));
  assert.ok(html.includes('Claude · orchid-board · 6 issues'));
  assert.ok(html.includes('Phase: v2 &#60;img src=x onerror=alert(1)&#62;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('feature/board-polish/dark-theme'));
  assert.ok(html.includes('Approve 6 issues'));
  assert.equal((await get('/inbox/prop_missing')).status, 404);
  assert.equal((await get('/inbox/bad%20id')).status, 404);
});

test('POSTs without the session CSRF token are refused and change nothing', async t => {
  const { store, authed } = await fixture(t);
  const id = propose(store).id;
  const { post } = await authed();
  for (const csrf of [null, 'forged']) {
    const fields: [string, string][] = [['op', 'save'], ['title:t1', 'renamed']];
    if (csrf) fields.push(['csrf', csrf]);
    assert.equal((await post(`/inbox/${id}`, fields)).status, 403);
    assert.equal((await post(`/inbox/${id}`, [...fields.filter(([k]) => k !== 'title:t1'), ['op', 'approve']])).status, 403);
    assert.equal((await post(`/inbox/${id}/send-back`, [...fields, ['key', 't1'], ['note:t1', 'x']])).status, 403);
  }
  // Another session's token does not work either.
  const other = await authed();
  const mine = await authed();
  assert.equal((await mine.post(`/inbox/${id}`, [['csrf', other.csrf], ['op', 'drop:t1']])).status, 403);
  const proposal = store.getProposal(id)!;
  assert.equal(proposal.nodes.find(n => n.key === 't1')!.title, 'dark-theme');
  assert.equal(proposal.state, 'pending');
  assert.deepEqual(store.droppedNodeKeys(id), []);
  assert.deepEqual(store.getFeedback(id).comments, []);
});

test('title edits and drops persist; approve creates the rest and kicks the writer', async t => {
  const { writer, kicked } = fakeWriter();
  const { store, authed } = await fixture(t, writer);
  const id = propose(store).id;
  const { csrf, post, get } = await authed();

  const saved = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'save'], ['title:t1', '  dark-mode '], ['title:t2', 'keyboard-nav']]);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), `/inbox/${id}`);
  assert.equal(store.getProposal(id)!.nodes.find(n => n.key === 't1')!.title, 'dark-mode');

  const empty = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'save'], ['title:t1', '   ']]);
  assert.equal(empty.status, 409);
  assert.match(await empty.text(), /Title must be non-empty/);
  assert.equal(store.getProposal(id)!.nodes.find(n => n.key === 't1')!.title, 'dark-mode');

  // Dropping a Feature drops its subtree; it can be restored until approval.
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'drop:f2']])).status, 303);
  assert.deepEqual(store.droppedNodeKeys(id), ['f2']);
  let html = await (await get(`/inbox/${id}`)).text();
  assert.ok(html.includes('aria-label="Restore notify"'));
  assert.ok(html.includes('Approve 4 issues'));
  assert.equal((html.match(/class="node [^"]*dropped/g) ?? []).length, 2);
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'restore:f2']])).status, 303);
  assert.deepEqual(store.droppedNodeKeys(id), []);
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'drop:f2']])).status, 303);

  // Ticked items block approval until they are sent back or unticked.
  const ticked = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'approve'], ['tick', 't2']]);
  assert.equal(ticked.status, 409);
  assert.equal(store.getProposal(id)!.state, 'pending');
  assert.deepEqual(kicked, []);

  const approved = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'approve']]);
  assert.equal(approved.status, 303);
  const after = store.getProposal(id)!;
  assert.equal(after.state, 'approved');
  assert.deepEqual(after.nodes.map(n => [n.key, n.status]), [['p', 'approved'], ['f1', 'approved'], ['t1', 'approved'], ['t2', 'approved']]);
  assert.deepEqual(kicked, [id]);
  assert.deepEqual(store.droppedNodeKeys(id), []);

  // Approved proposals are read-only.
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'approve']])).status, 409);
  assert.deepEqual(kicked, [id]);
  html = await (await get(`/inbox/${id}`)).text();
  assert.ok(html.includes('Approved. Creating 4 issues in GitHub.'));
  assert.ok(!html.includes('name="title:'));
});

test('send back: confirm step, a comment per item, feedback for get_feedback', async t => {
  const { store, authed } = await fixture(t);
  const id = propose(store).id;
  const { csrf, post } = await authed();

  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'review']])).status, 400);
  const review = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'review'], ['tick', 't2'], ['tick', 't3']]);
  assert.equal(review.status, 200);
  const dialog = await review.text();
  assert.ok(dialog.includes('role="dialog"'));
  assert.ok(dialog.includes('Send <span data-count>2</span> back to Claude?'));
  assert.match(dialog, /<textarea class="fld" name="note:t2" rows="2" required/);
  assert.ok(dialog.includes('aria-label="Keep phone-push"'));
  assert.deepEqual(store.getFeedback(id).sentBack, []);

  // "Keep" removes an item from the dialog without sending anything.
  const kept = await post(`/inbox/${id}/send-back`, [['csrf', csrf], ['key', 't2'], ['key', 't3'], ['note:t2', 'Split it'], ['untick', 't3']]);
  assert.equal(kept.status, 200);
  const keptHtml = await kept.text();
  assert.ok(!keptHtml.includes('name="note:t3"'));
  assert.ok(keptHtml.includes('>Split it</textarea>'));

  // Send is refused until every item has a comment.
  const missing = await post(`/inbox/${id}/send-back`, [['csrf', csrf], ['key', 't2'], ['key', 't3'], ['note:t2', 'Split it'], ['note:t3', '  ']]);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /Every item needs a comment/);
  assert.deepEqual(store.getFeedback(id).comments, []);

  const sent = await post(`/inbox/${id}/send-back`, [
    ['csrf', csrf], ['key', 't2'], ['key', 't3'], ['note:t2', ' Split it '], ['note:t3', 'Out of scope'], ['note', 'Keep v2 small'],
  ]);
  assert.equal(sent.status, 303);
  const feedback = store.getFeedback(id);
  assert.deepEqual(feedback.sentBack.map(n => n.key), ['t2', 't3']);
  assert.deepEqual(feedback.comments.map(c => [c.nodeKey, c.author, c.body]), [
    ['t2', 'Por', 'Split it'], ['t3', 'Por', 'Out of scope'], [null, 'Por', 'Keep v2 small'],
  ]);
  // Sent-back nodes cannot be sent again.
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'review'], ['tick', 't2']])).status, 409);
});

test('approve code is issued only on request and never appears in list pages', async t => {
  const { store, authed } = await fixture(t);
  const id = propose(store).id;
  const { csrf, post, get } = await authed();
  const before = await (await get(`/inbox/${id}`)).text();
  assert.ok(before.includes('value="code">Show approve code</button>'));
  assert.ok(!before.includes('class="code"'));

  const res = await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'code']]);
  assert.equal(res.status, 200);
  const code = /<div class="code">([2-9A-Z]{6})<\/div>/.exec(await res.text())?.[1];
  assert.ok(code);
  for (const path of ['/inbox', `/inbox/${id}`, '/', '/fragment']) {
    assert.ok(!(await (await get(path)).text()).includes(code), path);
  }
  // The code is the one an agent can use with the MCP approve tool.
  assert.deepEqual(store.approveProposal(id, code), { ok: true });
});

test('approved proposals show GitHub write progress and errors', async t => {
  const { writer } = fakeWriter({ error: 'node "f1" (Feature "<b>x</b>"): HTTP 502', failures: 1, retryAt: '2026-11-18T12:34:00.000Z' });
  const { store, authed } = await fixture(t, writer);
  const id = propose(store).id;
  const { csrf, post, get } = await authed();
  assert.equal((await post(`/inbox/${id}`, [['csrf', csrf], ['op', 'approve']])).status, 303);
  store.recordCreatedIssue(id, 'p', { number: 41, nodeId: 'I_41' });
  const html = await (await get(`/inbox/${id}`)).text();
  assert.ok(html.includes('data-writing'));
  assert.ok(html.includes('Write failed'));
  assert.ok(html.includes('HTTP 502'));
  assert.ok(html.includes('&#60;b&#62;x&#60;/b&#62;'));
  assert.ok(html.includes('Retries automatically at'));
  assert.ok(html.includes('Created #41'));
  assert.ok(html.includes(`href="https://github.com/${REPO}/issues/41"`));
  assert.ok(html.includes('Approved · writing'));
});
