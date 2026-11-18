import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ProjectRef, RepoRef } from '../../src/config.ts';
import { GitHubError } from '../../src/github/client.ts';
import type { Issue, PullRequest, RepoPullRequest } from '../../src/github/types.ts';
import { openStore } from '../../src/store/store.ts';
import { Poller } from '../../src/sync/poller.ts';
import type { SyncChange } from '../../src/sync/mirror.ts';

const REPO = 'companie-apps/orchid-board';
const OTHER = 'companie-apps/other';
const PR_REF = 'companie-apps/tools#21';
const INITIAL = '2026-11-18T00:00:00Z';
const UPDATED = '2026-11-18T00:01:00Z';
const EDITED = '2026-11-18T00:02:00Z';
const PROJECT = { owner: 'companie-apps', number: 7 };

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    ref: `${REPO}#${number}`, nodeId: `issue-${number}`, number,
    title: `Issue ${number}`, state: 'open', issueType: 'Task', updatedAt: INITIAL,
    parentRef: null, iteration: null, pullRequests: [], subIssueRefs: [],
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 21, url: 'https://github.com/companie-apps/tools/pull/21', title: 'Implement sync',
    updatedAt: UPDATED, state: 'open', draft: false, checkStatus: 'running',
    ...overrides,
  };
}

function repoPr(number: number, overrides: Partial<RepoPullRequest> = {}): RepoPullRequest {
  return {
    ...pr({ number, url: `https://github.com/${REPO}/pull/${number}` }),
    baseRefName: 'feature/core/core', bodyIssueRefs: [], githubIssueRefs: [], ...overrides,
  };
}

function fixture(t: TestContext, repos: RepoRef[] = [{ owner: 'COMPANIE-APPS', name: 'Orchid-Board' }]) {
  const store = openStore(':memory:');
  const changes: SyncChange[] = [];
  const errors: [string, unknown][] = [];
  const calls: { repo: string; since: string | null; project: ProjectRef | null }[] = [];
  const refreshes: [string, readonly string[]][] = [];
  const prCalls: [string, string | null][] = [];
  const remoteIssues = new Map<string, readonly Issue[] | Error>();
  const remotePrs = new Map<string, readonly PullRequest[]>();
  const remoteRepoPrs = new Map<string, readonly RepoPullRequest[] | Error>();
  let now = Date.parse(INITIAL);
  const poller = new Poller({
    store, repos, project: PROJECT, pollSeconds: 60,
    now: () => now,
    onError: (repo, error) => errors.push([repo, error]),
    createClient: ({ owner, name }) => {
      const repo = `${owner}/${name}`.toLowerCase();
      return {
        listIssues: async ({ since, project }) => {
          calls.push({ repo, since, project });
          const result = remoteIssues.get(repo) ?? [];
          if (result instanceof Error) throw result;
          return result;
        },
        listIssuePullRequests: async ids => {
          refreshes.push([repo, ids]);
          return new Map(ids.map(id => [id, remotePrs.get(id) ?? []]));
        },
        listRepoPullRequests: async since => {
          prCalls.push([repo, since]);
          const result = remoteRepoPrs.get(repo) ?? [];
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  });
  poller.events.on('change', change => changes.push(change));
  t.after(async () => {
    await poller.stop();
    store.close();
  });
  return {
    store, poller, changes, errors, calls, refreshes, prCalls, remoteIssues, remotePrs, remoteRepoPrs,
    advance: (ms: number) => { now += ms; },
  };
}

test('full startup replaces stale repo cache and keeps the store hierarchy and orphans', async t => {
  const { store, poller, changes, calls, remoteIssues } = fixture(t);
  store.setMeta(`sync:since:${REPO}`, UPDATED);
  const stale = `${REPO}#99`;
  const outOfScope = `${OTHER}#99`;
  for (const ref of [stale, outOfScope]) {
    store.upsertIssue({ ref, nodeId: ref, type: null, title: ref, state: 'open', parent: null, iteration: null, updatedAt: INITIAL });
  }
  const phase = issue(1, { issueType: 'Phase' });
  const feature = issue(2, { issueType: 'Feature', parentRef: phase.ref });
  const task = issue(3, {
    parentRef: feature.ref, state: 'closed', pullRequests: [pr({ state: 'merged', checkStatus: 'pass' })],
    iteration: { iterationId: 'sprint-id', title: 'Sprint' },
  });
  const untyped = issue(4, { issueType: null, parentRef: phase.ref });
  const unparented = issue(5, { issueType: 'Feature' });
  remoteIssues.set(REPO, [task, untyped, unparented, phase, feature]);

  await poller.pollOnce();

  assert.deepEqual(calls, [{ repo: REPO, since: null, project: PROJECT }]);
  assert.equal(store.getMeta(`sync:since:${REPO}`), INITIAL);
  assert.equal(store.getIssue(stale), null);
  const tree = store.getTree();
  assert.deepEqual(tree.roots.map(root => root.ref), [phase.ref]);
  const [featureNode] = tree.roots[0]!.children;
  assert.equal(featureNode?.ref, feature.ref);
  const [taskNode] = featureNode!.children;
  assert.equal(taskNode?.ref, task.ref);
  assert.equal(taskNode.state, 'closed');
  assert.deepEqual(taskNode.iteration, { id: 'sprint-id', title: 'Sprint' });
  assert.deepEqual(taskNode.prs.map(item => [item.ref, item.title, item.state, item.checks, item.updatedAt]), [
    [PR_REF, 'Implement sync', 'merged', 'pass', UPDATED],
  ]);
  assert.deepEqual(tree.orphans.map(orphan => orphan.ref).sort(), [untyped.ref, unparented.ref, outOfScope].sort());
  assert.deepEqual(changes, [{
    repo: REPO, issues: [phase.ref, feature.ref, task.ref, untyped.ref, unparented.ref, stale], prs: [PR_REF],
  }]);
});

test('incremental updates replay the inclusive cursor and publish a check-only change on a cached issue', async t => {
  const { store, poller, calls, changes, refreshes, remoteIssues, remotePrs } = fixture(t);
  const task = issue(1, { pullRequests: [pr()] });
  const other = issue(2, { updatedAt: UPDATED });
  remoteIssues.set(REPO, [task, other]);
  await poller.pollOnce();
  changes.length = 0;

  const closed = { ...other, state: 'closed' as const };
  remoteIssues.set(REPO, [closed]);
  remotePrs.set(task.nodeId, [pr({ checkStatus: 'fail' })]);
  await poller.pollOnce();
  await poller.pollOnce();

  assert.deepEqual(calls.map(call => call.since), [null, UPDATED, UPDATED]);
  assert.deepEqual(refreshes, [[REPO, [task.nodeId]], [REPO, [task.nodeId]]]);
  assert.equal(store.getTree({ state: 'closed' }).orphans[0]?.ref, closed.ref);
  assert.equal(store.getTree().orphans[0]?.prs[0]?.checks, 'fail');
  assert.deepEqual(changes, [{ repo: REPO, issues: [task.ref, closed.ref], prs: [PR_REF] }]);
});

test('a PR keeps links across a partial update and across configured repositories', async t => {
  const { store, poller, changes, remoteIssues, remotePrs } = fixture(t, [
    { owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' },
  ]);
  const first = issue(1, { pullRequests: [pr()] });
  const second = issue(2, { pullRequests: [pr()] });
  const third = issue(3, { ref: `${OTHER}#3`, pullRequests: [pr()] });
  remoteIssues.set(REPO, [first, second]);
  remoteIssues.set(OTHER, [third]);
  await poller.pollOnce();
  assert.deepEqual(store.getPr(PR_REF)?.issues, [first.ref, second.ref, third.ref]);
  changes.length = 0;

  remoteIssues.set(REPO, [{ ...first, updatedAt: UPDATED, pullRequests: [] }]);
  remotePrs.set(second.nodeId, [pr()]);
  await poller.pollOnce();

  assert.deepEqual(store.getPr(PR_REF)?.issues, [second.ref, third.ref]);
  assert.deepEqual(store.prsForIssue(first.ref), []);
  assert.deepEqual(changes, [{ repo: REPO, issues: [first.ref, second.ref, third.ref], prs: [PR_REF] }]);
});

test('body links update across repos and coexist with GitHub closing refs', async t => {
  const { store, poller, changes, prCalls, remoteIssues, remotePrs, remoteRepoPrs } = fixture(t, [
    { owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' },
  ]);
  const task = issue(6);
  const other = issue(2, { ref: 'companie-apps/Other#2' });
  const historical = repoPr(24, { state: 'merged', updatedAt: INITIAL, bodyIssueRefs: [task.ref] });
  const feature = repoPr(22, { updatedAt: INITIAL, bodyIssueRefs: [task.ref, `${OTHER}#2`] });
  const defaultBranch = repoPr(23, { baseRefName: 'main', bodyIssueRefs: [task.ref], githubIssueRefs: [task.ref] });
  remoteIssues.set(REPO, [{ ...task, pullRequests: [defaultBranch] }]);
  remoteIssues.set(OTHER, [other]);
  remoteRepoPrs.set(REPO, [feature, defaultBranch, historical]);
  await poller.pollOnce();

  assert.deepEqual(store.getPr(`${REPO}#22`)?.issues, [other.ref, task.ref]);
  assert.deepEqual(store.prsForIssue(other.ref).map(pr => pr.number), [22]);
  assert.deepEqual(store.prsForIssue(task.ref).map(pr => pr.number), [22, 23, 24]);
  assert.equal(store.getMeta(`sync:since:${REPO}`), INITIAL);
  assert.equal(store.getMeta(`sync:prs:since:${REPO}`), UPDATED);

  changes.length = 0;
  remoteIssues.set(REPO, []);
  remoteIssues.set(OTHER, []);
  remotePrs.set(task.nodeId, [defaultBranch]);
  remoteRepoPrs.set(REPO, [{ ...feature, checkStatus: 'pass' }, defaultBranch]);
  await poller.pollOnce();

  assert.equal(store.getPr(`${REPO}#22`)?.checks, 'pass');
  assert.deepEqual(store.prsForIssue(task.ref).map(pr => pr.number), [22, 23, 24]);
  assert.deepEqual(changes, [{ repo: REPO, issues: [other.ref, task.ref], prs: [`${REPO}#22`] }]);

  changes.length = 0;
  remoteRepoPrs.set(REPO, [
    { ...feature, state: 'closed', updatedAt: EDITED, bodyIssueRefs: [] },
    { ...defaultBranch, bodyIssueRefs: [] },
  ]);
  await poller.pollOnce();

  assert.equal(store.getPr(`${REPO}#22`), null);
  assert.deepEqual(store.prsForIssue(other.ref), []);
  assert.deepEqual(store.prsForIssue(task.ref).map(pr => pr.number), [23, 24]);
  assert.deepEqual(changes, [{ repo: REPO, issues: [other.ref, task.ref], prs: [`${REPO}#22`] }]);
  assert.deepEqual(prCalls.filter(([repo]) => repo === REPO), [[REPO, null], [REPO, UPDATED], [REPO, UPDATED]]);
  assert.equal(store.getMeta(`sync:prs:since:${REPO}`), EDITED);
});

test('transfers remove old refs and stale pull request links and report both issue refs', async t => {
  const { store, poller, changes, remoteIssues } = fixture(t);
  const incoming = issue(1);
  const previousRef = `${OTHER}#7`;
  store.upsertIssue({
    ref: previousRef, nodeId: incoming.nodeId, title: 'Transferred', type: 'Task',
    state: 'open', parent: null, iteration: null, updatedAt: INITIAL,
  });
  store.upsertPr({ ...pr(), ref: PR_REF, issues: [previousRef] });
  remoteIssues.set(REPO, [incoming]);

  await poller.pollOnce();

  assert.equal(store.getIssue(previousRef), null);
  assert.equal(store.getIssue(incoming.ref)?.nodeId, incoming.nodeId);
  assert.equal(store.getPr(PR_REF), null);
  assert.deepEqual(changes, [{ repo: REPO, issues: [incoming.ref, previousRef], prs: [PR_REF] }]);
});

test('a failed poll retries that repo without advancing the cursor or publishing partial writes', async t => {
  const { store, poller, errors, changes, calls, prCalls, remoteIssues, remoteRepoPrs } = fixture(t);
  const task = issue(1, { pullRequests: [pr({ url: 'https://example.com/pull/21' })] });
  remoteIssues.set(REPO, [task]);
  remoteRepoPrs.set(REPO, [repoPr(22)]);
  await poller.pollOnce();
  assert.equal(store.getMeta(`sync:since:${REPO}`), null);
  assert.equal(store.getMeta(`sync:prs:since:${REPO}`), null);
  assert.equal(store.getIssue(task.ref), null);
  assert.deepEqual(changes, []);
  assert.match(String(errors[0]?.[1]), /invalid pull request URL/);

  remoteIssues.set(REPO, [{ ...task, pullRequests: [pr()] }]);
  await poller.pollOnce();
  assert.deepEqual(calls.map(call => call.since), [null, null]);
  assert.deepEqual(prCalls, [[REPO, null], [REPO, null]]);
  assert.equal(store.getIssue(task.ref)?.ref, task.ref);
  assert.equal(store.getMeta(`sync:since:${REPO}`), INITIAL);
  assert.equal(store.getMeta(`sync:prs:since:${REPO}`), UPDATED);
  assert.equal(changes.length, 1);
});

test('a repo honors its rate-limit delay while the other repo keeps polling', async t => {
  const { store, poller, calls, errors, remoteIssues, advance } = fixture(t, [
    { owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' },
  ]);
  const limited = new GitHubError('rate limited', 429, 90_000);
  remoteIssues.set(REPO, limited);
  const other = issue(2, { ref: `${OTHER}#2` });
  remoteIssues.set(OTHER, [other]);
  await poller.pollOnce();
  assert.equal(store.getIssue(other.ref)?.title, other.title);
  assert.equal(store.getMeta(`sync:since:${REPO}`), null);
  assert.deepEqual(errors, [[REPO, limited]]);

  advance(60_000);
  await poller.pollOnce();
  assert.deepEqual(calls.map(call => [call.repo, call.since]), [[REPO, null], [OTHER, null], [OTHER, INITIAL]]);

  advance(30_000);
  const recovered = issue(3);
  remoteIssues.set(REPO, [recovered]);
  await poller.pollOnce();
  assert.deepEqual(calls.slice(-2).map(call => [call.repo, call.since]), [[REPO, null], [OTHER, INITIAL]]);
  assert.equal(store.getIssue(recovered.ref)?.ref, recovered.ref);
});

test('slow repos do not overlap or hold up another repo, and stop aborts in-flight work', async t => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  let notifySecondPoll!: () => void;
  const secondGoodPoll = new Promise<void>(resolve => { notifySecondPoll = resolve; });
  const poller = new Poller({
    store, pollSeconds: 60,
    repos: [{ owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' }],
    createClient: ({ name }, signal) => ({
      listIssues: async () => {
        calls.push(name);
        if (name === 'orchid-board') {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          return [issue(3)];
        }
        if (calls.length === 3) notifySecondPoll();
        return [];
      },
      listIssuePullRequests: async () => new Map(),
      listRepoPullRequests: async () => [],
    }),
  });
  t.after(async () => {
    await poller.stop();
    store.close();
  });
  poller.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  const overlappingTick = poller.pollOnce();
  await secondGoodPoll;
  await poller.stop();
  await overlappingTick;
  await poller.pollOnce();

  assert.deepEqual(calls, ['orchid-board', 'other', 'other']);
  assert.equal(store.getIssue(`${REPO}#3`), null);
  assert.ok(store.getMeta(`sync:since:${OTHER}`));
});

test('incremental PR refresh skips closed issues that GitHub did not return', async t => {
  const { poller, refreshes, remoteIssues } = fixture(t);
  const open = issue(1);
  const closed = issue(2, { state: 'closed' });
  remoteIssues.set(REPO, [open, closed]);
  await poller.pollOnce();

  remoteIssues.set(REPO, []);
  await poller.pollOnce();

  assert.deepEqual(refreshes, [[REPO, [open.nodeId]]]);
});

test('lastSyncAt tracks the oldest repo and stays put when a poll fails', async t => {
  const { poller, remoteIssues, advance } = fixture(t, [{ owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' }]);
  const synced: number[] = [];
  poller.events.on('synced', at => synced.push(at));
  remoteIssues.set(OTHER, new Error('down'));
  await poller.pollOnce();
  // One repo has synced, the other has not: no sync time yet.
  assert.equal(poller.lastSyncAt, null);
  assert.deepEqual(synced, []);

  advance(60_000);
  remoteIssues.set(OTHER, []);
  await poller.pollOnce();
  const first = Date.parse(INITIAL) + 60_000;
  assert.equal(poller.lastSyncAt, first);
  // Emitted once every repo has synced: not for orchid-board alone, then for the other repo.
  assert.deepEqual(synced, [first]);

  advance(60_000);
  remoteIssues.set(OTHER, new Error('down'));
  await poller.pollOnce();
  // orchid-board moved on; the failed repo holds the oldest successful poll.
  assert.equal(poller.lastSyncAt, first);
  assert.deepEqual(synced, [first, first]);
});

test('pollNow polls only the named repos and repeats a poll that was already running', async t => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  let release!: () => void;
  let gate: Promise<void> | null = new Promise<void>(resolve => { release = resolve; });
  let polled!: () => void;
  const done = new Promise<void>(resolve => { polled = resolve; });
  const poller = new Poller({
    store, pollSeconds: 60,
    repos: [{ owner: 'companie-apps', name: 'orchid-board' }, { owner: 'companie-apps', name: 'other' }],
    createClient: ({ name }) => ({
      listIssues: async () => {
        calls.push(name);
        if (gate) await gate;
        if (calls.length === 2) polled();
        return [];
      },
      listIssuePullRequests: async () => new Map(),
      listRepoPullRequests: async () => [],
    }),
  });
  t.after(async () => {
    await poller.stop();
    store.close();
  });

  poller.pollNow(['Companie-Apps/Orchid-Board']);
  poller.pollNow([REPO]);
  assert.deepEqual(calls, ['orchid-board']);
  gate = null;
  release();
  await done;
  assert.deepEqual(calls, ['orchid-board', 'orchid-board']);
});
