import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { openStore, type IssueInput, type Store, type TreeNode } from '../../src/store/store.ts';
import {
  boardHref, branchOf, parseQuery, renderApp, renderLogin, renderPage, rollupStatus, slugOf, taskStatus,
  type BoardQuery, type BoardView,
} from '../../src/web/render.ts';

const REPO = 'companie-apps/orchid-board';
const IOS = 'companie-apps/jernie-mobile-ios';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const SPRINT = { id: 'it-1', title: 'Sprint 1' };
const SNAPSHOT = new URL('../fixtures/web/board.html', import.meta.url);

function issue(ref: string, overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    ref, nodeId: `node-${ref}`, type: 'Task', title: `Issue ${ref}`, state: 'open',
    parent: null, iteration: SPRINT, updatedAt: '2026-11-18T00:00:00Z', ...overrides,
  };
}

function pr(ref: string, issues: string[], state: 'open' | 'closed' | 'merged', draft: boolean, checks: 'pass' | 'fail' | 'running' | 'none') {
  const [repo, number] = ref.split('#');
  return { ref, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${ref}`, state, draft, issues, updatedAt: '2026-11-18T00:00:00Z', checks };
}

/** Phase #1 → Feature #2 (core: 4 tasks) + Feature #3 (board: 1 task), plus an iOS feature with no phase. */
function fixtureStore(): Store {
  const store = openStore(':memory:', { now: () => new Date(NOW) });
  store.upsertIssues([
    issue(`${REPO}#1`, { type: 'Phase', title: 'Orchid Board v1', iteration: null }),
    issue(`${REPO}#2`, { type: 'Feature', title: 'core: GitHub mirror', parent: `${REPO}#1` }),
    issue(`${REPO}#6`, { title: 'bootstrap: repo skeleton', parent: `${REPO}#2`, state: 'closed' }),
    issue(`${REPO}#8`, { title: 'github-client: fetch wrapper', parent: `${REPO}#2` }),
    issue(`${REPO}#9`, { title: 'sync: poller', parent: `${REPO}#2` }),
    issue(`${REPO}#7`, { title: 'store <script>alert(1)</script> & "quotes"', parent: `${REPO}#2` }),
    issue(`${REPO}#3`, { type: 'Feature', title: 'board: web board', parent: `${REPO}#1`, iteration: { id: 'it-2', title: 'Sprint 2' } }),
    issue(`${REPO}#10`, { title: 'web-board: tree view', parent: `${REPO}#3`, iteration: { id: 'it-2', title: 'Sprint 2' } }),
    issue(`${IOS}#463`, { type: 'Feature', title: 'Jernie 463' }),
    issue(`${IOS}#474`, { title: 'jernie-474', parent: `${IOS}#463` }),
    issue(`${IOS}#999`, { type: null, title: 'stray typeless issue' }),
  ]);
  store.upsertPr(pr(`${REPO}#16`, [`${REPO}#6`], 'merged', false, 'pass'));
  store.upsertPr(pr(`${REPO}#18`, [`${REPO}#8`], 'open', true, 'running'));
  store.upsertPr(pr(`${REPO}#19`, [`${REPO}#9`], 'open', false, 'fail'));
  store.upsertPr({ ...pr(`${REPO}#20`, [`${REPO}#7`], 'merged', false, 'fail'), url: 'javascript:alert(1)' });
  store.upsertPr(pr(`${IOS}#480`, [`${IOS}#474`], 'open', false, 'pass'));
  store.claim(`${REPO}#8`, 'Claude', { ttlMs: 3_600_000, now: new Date(NOW - 14 * 60_000) });
  return store;
}

function view(store: Store, query: BoardQuery): BoardView {
  const issues = store.listIssues();
  return {
    tree: store.getTree({ ...(query.repo ? { repo: query.repo } : {}), ...(query.sprint ? { iteration: query.sprint } : {}) }),
    repos: [...new Set(issues.map(i => i.repo))].sort(),
    sprints: ['Sprint 1', 'Sprint 2'],
    issueCount: issues.length,
    lastSyncAt: NOW - 12_000,
    mcpPort: 4311,
    now: NOW,
  };
}

const ALL: BoardQuery = { repo: null, sprint: null, status: 'all', sel: null };

function node(store: Store, ref: string): TreeNode {
  const find = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.ref === ref) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const tree = store.getTree();
  const hit = find([...tree.roots, ...tree.orphans]);
  assert.ok(hit, ref);
  return hit;
}

test('render matches the fixture-tree snapshot', () => {
  const html = renderApp(view(fixtureStore(), ALL), { ...ALL, sel: `${REPO}#8` });
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(new URL('.', SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, html);
  }
  assert.equal(html, readFileSync(SNAPSHOT, 'utf8'));
});

test('issue text is escaped and unsafe links are dropped', () => {
  const html = renderPage(view(fixtureStore(), ALL), { ...ALL, sel: `${REPO}#7` });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('store &#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;quotes&#34;'));
  assert.ok(!html.includes('javascript:'));
  // CSP is default-src 'self': no inline styles, scripts or handlers.
  assert.ok(!/\sstyle=/.test(html));
  assert.ok(!/\son[a-z]+=/.test(html));
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.ok(html.includes('<script src="/board.js" defer></script>'));
});

test('login page escapes the error and has no inline script', () => {
  const html = renderLogin('<b>nope</b>');
  assert.ok(html.includes('&#60;b&#62;nope&#60;/b&#62;'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('action="/login"'));
});

test('task status derivation', () => {
  const store = fixtureStore();
  assert.deepEqual(taskStatus(node(store, `${REPO}#6`)), { tone: 'done', label: 'Done' });
  assert.deepEqual(taskStatus(node(store, `${REPO}#8`)), { tone: 'working', label: 'Working' });
  assert.deepEqual(taskStatus(node(store, `${REPO}#9`)), { tone: 'failed', label: 'CI failed' });
  // A merged PR with a red rollup does not fail the task.
  assert.deepEqual(taskStatus(node(store, `${REPO}#7`)), { tone: 'idle', label: 'Open' });
  assert.deepEqual(taskStatus(node(store, `${IOS}#474`)), { tone: 'waiting', label: 'Needs you' });
  assert.deepEqual(taskStatus(node(store, `${REPO}#10`)), { tone: 'idle', label: 'Open' });
});

test('feature and phase status roll up their tasks', () => {
  const store = fixtureStore();
  assert.deepEqual(rollupStatus(node(store, `${REPO}#2`)), { tone: 'failed', label: '1 failing' });
  assert.deepEqual(rollupStatus(node(store, `${REPO}#3`)), { tone: 'idle', label: '0 of 1 done' });
  assert.deepEqual(rollupStatus(node(store, `${IOS}#463`)), { tone: 'waiting', label: 'Needs you' });
  assert.deepEqual(rollupStatus(node(store, `${REPO}#1`)), { tone: 'failed', label: '1 failing' });
});

test('branch names follow feature/<f>/<f> and feature/<f>/<task>', () => {
  const store = fixtureStore();
  const feature = node(store, `${REPO}#3`);
  assert.equal(slugOf('web-board: tree view w/ badges'), 'web-board');
  assert.equal(slugOf('Jernie 463'), 'jernie-463');
  assert.equal(branchOf(feature, null), 'feature/board/board');
  assert.equal(branchOf(node(store, `${REPO}#10`), feature), 'feature/board/web-board');
  assert.equal(branchOf(node(store, `${REPO}#1`), null), null);
});

test('status filter keeps matching tasks and their ancestors', () => {
  const html = renderApp(view(fixtureStore(), ALL), { ...ALL, status: 'needs' });
  assert.ok(html.includes(`data-ref="${IOS}#474"`));
  assert.ok(html.includes(`data-ref="${IOS}#463"`));
  assert.ok(!html.includes(`data-ref="${REPO}#8"`));
  assert.ok(html.includes('class="app filtered"'));
  assert.ok(html.includes('1 needs you.'));
  assert.ok(html.includes('PR #480 ready for review on #474.'));
});

test('typeless leaf issues are left out of the tree', () => {
  const html = renderApp(view(fixtureStore(), ALL), ALL);
  assert.ok(!html.includes('stray typeless issue'));
});

test('parseQuery validates every filter', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('')), ALL);
  assert.deepEqual(
    parseQuery(new URLSearchParams(`repo=${REPO}&sprint=Sprint+1&status=failed&sel=${encodeURIComponent(`${REPO}#8`)}`)),
    { repo: REPO, sprint: 'Sprint 1', status: 'failed', sel: `${REPO}#8` },
  );
  assert.deepEqual(
    parseQuery(new URLSearchParams('repo=../etc&status=bogus&sel=javascript:alert(1)&sprint=')),
    ALL,
  );
  assert.equal(parseQuery(new URLSearchParams(`sprint=${'x'.repeat(201)}`)).sprint, null);
});

test('boardHref round-trips through parseQuery and drops defaults', () => {
  const query: BoardQuery = { repo: REPO, sprint: 'Sprint 1', status: 'working', sel: `${REPO}#8` };
  const href = boardHref(query);
  assert.deepEqual(parseQuery(new URL(href, 'http://x').searchParams), query);
  assert.equal(boardHref(ALL), '/');
  assert.equal(boardHref(query, { repo: null, sprint: null, status: 'all', sel: null }), '/');
});
