import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { issueApproveCode } from '../../src/proposals/approve-code.ts';
import { proposalTools } from '../../src/proposals/tools.ts';
import { dbPath, schemaVersion } from '../../src/store/db.ts';
import { openStore, type IssueInput, type Proposal, type Store } from '../../src/store/store.ts';

const repo = 'companie-apps/orchid-board';
const repos = [{ owner: 'companie-apps', name: 'orchid-board' }];
const start = new Date('2026-11-18T00:00:00.000Z');
const phase = { key: 'phase', type: 'Phase', repo, title: 'Phase one' };
const feature = { key: 'feature', type: 'Feature', repo, title: 'Reviews' };
const task = { key: 'task', type: 'Task', repo, title: 'Draft' };

function cache(store: Store, number: number, type: IssueInput['type'], title: string, parent?: number): void {
  store.upsertIssue({
    ref: repo + '#' + number,
    nodeId: 'I_' + number,
    type,
    title,
    state: 'open',
    parent: parent === undefined ? null : repo + '#' + parent,
    iteration: null,
    updatedAt: start.toISOString(),
  });
}

async function setup(t: TestContext) {
  let now = start;
  const store = openStore(':memory:', { now: () => now });
  const server = new McpServer({ name: 'orchid-board', version: 'test' });
  proposalTools({ store, repos })(server);
  const client = new Client({ name: 'proposals-test', version: 'test' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(Array.isArray(result.content));
    const [content] = result.content;
    assert.equal(content?.type, 'text');
    return { result, text: content.text as string };
  };
  const success = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await call(name, args);
    assert(!response.result.isError, response.text);
    return JSON.parse(response.text) as T;
  };
  const error = async (name: string, args: Record<string, unknown>, message: RegExp) => {
    const response = await call(name, args);
    assert.equal(response.result.isError, true);
    assert.match(response.text, message);
    return response.result;
  };
  const propose = (nodes: unknown[], parent?: string) =>
    success<Proposal>('propose_tree', { agent: '  builder  ', nodes, parent });
  return { store, client, call, success, error, propose, setClock: (value: Date) => { now = value; } };
}

it('registers all four proposal tools and stores a typed draft without changing the issue cache', async t => {
  const { store, client, propose } = await setup(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['approve', 'get_feedback', 'propose_tree', 'resubmit']);
  const proposal = await propose([{ ...phase, children: [
    { ...feature, children: [{ ...task, key: undefined, title: '  Draft changes  ', body: 'Details', iteration: 'Sprint 2' }] },
  ] }]);
  assert.equal(proposal.agent, 'builder');
  assert.equal(proposal.state, 'pending');
  assert.deepEqual(proposal.nodes.map(node => [node.key, node.parentKey, node.title, node.branch]), [
    ['phase', null, 'Phase one', null],
    ['feature', 'phase', 'Reviews', 'feature/reviews/reviews'],
    [proposal.nodes[2]!.key, 'feature', 'Draft changes', 'feature/reviews/draft-changes'],
  ]);
  assert.match(proposal.nodes[2]!.key, /^[0-9a-f-]{36}$/);
  assert.equal(proposal.nodes[2]!.body, 'Details');
  assert.equal(proposal.nodes[2]!.iteration, 'Sprint 2');
  assert.deepEqual(store.getProposal(proposal.id), proposal);
  assert.deepEqual(store.listIssues(), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM approve_codes').get()?.count, 0);
});

it('validates levels, types, titles, configured repos and cached parents', async t => {
  const { store, error, propose } = await setup(t);
  cache(store, 1, 'Phase', 'Existing phase');
  cache(store, 2, 'Feature', 'Existing feature', 1);
  cache(store, 3, 'Task', 'Existing task', 2);
  cache(store, 4, null, 'Untyped issue');
  const cases: Array<[unknown[], string | undefined, RegExp]> = [
    [[feature], undefined, /expected a Phase/],
    [[{ ...phase, children: [task] }], undefined, /expected a Feature/],
    [[{ ...phase, children: [{ ...feature, children: [phase] }] }], undefined, /expected a Task/],
    [[{ ...phase, children: [{ ...feature, children: [{ ...task, children: [task] }] }] }], undefined, /validation error/],
    [[{ ...phase, title: ' \t ' }], undefined, /title must be non-empty/],
    [[{ ...phase, children: [{ ...feature, repo: 'other/repo' }] }], undefined, /outside config\.repos/],
    [[phase, phase], undefined, /duplicate node key/],
    [[task], repo + '#1', /expected a Feature/],
    [[feature], repo + '#2', /expected a Task/],
    [[task], repo + '#3', /a Task cannot have child nodes/],
    [[phase], repo + '#4', /has no issue type/],
    [[phase], repo + '#99', /missing from the board cache/],
    [[], undefined, /validation error/],
  ];
  for (const [nodes, parent, message] of cases) {
    await error('propose_tree', { agent: 'builder', parent, nodes }, message);
  }
  assert.deepEqual(store.listProposals(), []);
  const underPhase = await propose([feature], repo + '#1');
  assert.equal(underPhase.nodes[0]!.branch, 'feature/reviews/reviews');
  const underFeature = await propose([task], repo + '#2');
  assert.equal(underFeature.nodes[0]!.branch, 'feature/existing-feature/draft');
  assert.equal(underFeature.nodes[0]!.parentKey, null);
});

it('derives Unicode-safe slugs with bounded suffixes and keeps feature and task refs distinct', async t => {
  const { propose } = await setup(t);
  const long = 'a'.repeat(60);
  const { nodes } = await propose([{ ...phase, children: [
    { ...feature, title: '  Café — déjà   vu  ', children: [
      { ...task, title: 'Café déjà vu' },
      { ...task, key: 'task2', title: 'Also___café' },
      { ...task, key: 'task3', title: 'Also---café' },
      { ...task, key: 'task4', title: 'กล้วย' },
      { ...task, key: 'task5', title: long },
      { ...task, key: 'task6', title: long },
    ] },
    { ...feature, key: 'feature2', title: 'CAFE déjà vu' },
  ] }]);
  assert.deepEqual(nodes.map(node => node.branch), [
    null,
    'feature/cafe-deja-vu/cafe-deja-vu',
    'feature/cafe-deja-vu/cafe-deja-vu-2',
    'feature/cafe-deja-vu/also-cafe',
    'feature/cafe-deja-vu/also-cafe-2',
    'feature/cafe-deja-vu/task',
    'feature/cafe-deja-vu/' + 'a'.repeat(40),
    'feature/cafe-deja-vu/' + 'a'.repeat(38) + '-2',
    'feature/cafe-deja-vu-2/cafe-deja-vu-2',
  ]);
});

it('uses recorded branches and accounts for cached siblings under an existing issue', async t => {
  const { store, propose } = await setup(t);
  cache(store, 1, 'Phase', 'Existing phase');
  cache(store, 2, 'Feature', 'Reviews', 1);
  cache(store, 3, 'Feature', 'Renamed feature', 1);
  cache(store, 4, 'Task', 'Draft', 3);
  const plan = store.createProposal({
    nodes: [{ ...feature, type: 'Feature', branch: 'feature/reviews-2/reviews-2' }],
  });
  store.recordCreatedIssue(plan.id, feature.key, { number: 3, nodeId: 'I_3' });
  const underPhase = await propose([feature], repo + '#1');
  assert.equal(underPhase.nodes[0]!.branch, 'feature/reviews-3/reviews-3');
  const underFeature = await propose([task], repo + '#3');
  assert.equal(underFeature.nodes[0]!.branch, 'feature/reviews-2/draft-2');
});

it('keeps codes out of tool results and locks the fifth wrong guess until a fresh code is issued', async t => {
  const { store, propose, call, error } = await setup(t);
  const proposal = await propose([phase]);
  const args = { proposal: proposal.id };
  await error('approve', { ...args, code: 'invalid' }, /no approve code/i);
  const code = issueApproveCode(store, proposal.id, start);
  assert.match(code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert(!JSON.stringify(proposal).includes(code));
  const row = store.db.prepare('SELECT * FROM approve_codes').get()!;
  assert.match(String(row.code_hash), /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(row).includes(code));
  const feedback = await call('get_feedback', args);
  assert(!JSON.stringify(feedback.result).includes(code));
  for (let guess = 1; guess <= 4; guess++) {
    const wrong = await error('approve', { ...args, code: 'invalid' }, /incorrect approve code/i);
    assert(!JSON.stringify(wrong).includes(code));
  }
  await error('approve', { ...args, code: 'invalid' }, /locked after five/i);
  const locked = await error('approve', { ...args, code }, /locked/i);
  assert(!JSON.stringify(locked).includes(code));
  assert.equal(store.getProposal(proposal.id)!.state, 'pending');
  const fresh = issueApproveCode(store, proposal.id, start);
  const approved = await call('approve', { ...args, code: fresh });
  assert(!approved.result.isError);
  assert.deepEqual(JSON.parse(approved.text), { proposal: proposal.id, state: 'approved' });
  assert(!JSON.stringify(approved.result).includes(fresh));
  assert.equal(store.getProposal(proposal.id)!.nodes[0]!.status, 'approved');
  const replay = await error('approve', { ...args, code: fresh }, /already been used/i);
  assert(!JSON.stringify(replay).includes(fresh));
  assert.throws(() => issueApproveCode(store, proposal.id, start), /only pending proposals/);
});

it('expires unused codes and keeps the code valid if the approval transaction rolls back', async t => {
  const { store, propose, setClock, error, success } = await setup(t);
  const { id } = await propose([phase]);
  const code = issueApproveCode(store, id, start);
  const expiresAt = new Date(start.getTime() + 15 * 60_000);
  setClock(expiresAt);
  const expired = await error('approve', { proposal: id, code }, /expired/i);
  assert(!JSON.stringify(expired).includes(code));
  await error('approve', { proposal: id, code: 'invalid' }, /expired/i);
  const fresh = issueApproveCode(store, id, expiresAt);
  store.db.exec("CREATE TRIGGER fail_approval BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'fail'); END");
  await error('approve', { proposal: id, code: fresh }, /internal error/i);
  assert.equal(store.getProposal(id)!.nodes[0]!.status, 'draft');
  store.db.exec('DROP TRIGGER fail_approval');
  await success('approve', { proposal: id, code: fresh });
  assert.equal(store.getProposal(id)!.state, 'approved');
});

it('returns feedback and replaces only sent-back subtrees, with fresh review after a partial approval', async t => {
  const { store, propose, success, error } = await setup(t);
  const { id } = await propose([{ ...phase, children: [
    { ...feature, children: [task] },
    { ...feature, key: 'keep', title: 'Keep' },
  ] }]);
  store.sendBack(id, 'feature', { author: 'Por', body: 'Split the tasks' });
  store.addFeedback(id, null, 'Por', 'The other feature looks good.');
  const feedback = await success<ReturnType<Store['getFeedback']>>('get_feedback', { proposal: id });
  assert.deepEqual(feedback.sentBack.map(node => node.key), ['feature']);
  assert.deepEqual(feedback.comments.map(comment => [comment.nodeKey, comment.author, comment.body]), [
    ['feature', 'Por', 'Split the tasks'],
    [null, 'Por', 'The other feature looks good.'],
  ]);

  const code = issueApproveCode(store, id, start);
  await success('approve', { proposal: id, code });
  assert.deepEqual(store.getProposal(id)!.nodes.map(node => node.status), ['approved', 'sent_back', 'draft', 'approved']);
  store.recordCreatedIssue(id, 'phase', { number: 10, nodeId: 'I_10' });
  store.recordCreatedIssue(id, 'keep', { number: 11, nodeId: 'I_11' });
  store.setProposalState(id, 'done');
  const before = store.getProposal(id);
  await error('resubmit', { proposal: id, nodes: [task] }, /was not sent back/);
  await error('resubmit', { proposal: id, nodes: [{ ...feature, type: 'Task' }] }, /expected a Feature/);
  await error('resubmit', { proposal: id, nodes: [{ ...feature, children: [{ ...task, key: 'keep' }] }] }, /duplicate node key/);
  await error('resubmit', { proposal: id, nodes: [{ ...feature, key: undefined }] }, /needs its sent-back node key/);
  assert.deepEqual(store.getProposal(id), before);
  const after = await success<Proposal>('resubmit', { proposal: id, nodes: [
    { ...feature, title: 'Keep', children: [
      { ...task, key: 'new1', title: 'Gather examples' },
      { ...task, key: 'new2', title: 'Write docs' },
    ] },
  ] });
  assert(!JSON.stringify(after).includes(code));
  assert.equal(after.state, 'pending');
  assert.deepEqual(after.nodes.map(node => [node.key, node.parentKey, node.branch, node.status, node.issueNumber]), [
    ['phase', null, null, 'created', 10],
    ['feature', 'phase', 'feature/keep-2/keep-2', 'draft', null],
    ['new1', 'feature', 'feature/keep-2/gather-examples', 'draft', null],
    ['new2', 'feature', 'feature/keep-2/write-docs', 'draft', null],
    ['keep', 'phase', 'feature/keep/keep', 'created', 11],
  ]);
  const afterFeedback = await success<ReturnType<Store['getFeedback']>>('get_feedback', { proposal: id });
  assert.deepEqual(afterFeedback, { sentBack: [], comments: feedback.comments });
  await error('approve', { proposal: id, code }, /already been used/);
  await success('approve', { proposal: id, code: issueApproveCode(store, id, start) });
  assert.deepEqual(store.getProposal(id)!.nodes.map(node => node.status), ['created', 'approved', 'approved', 'approved', 'created']);
});

it('invalidates an outstanding code when a sent-back root is replaced', async t => {
  const { store, propose, success, error } = await setup(t);
  const { id } = await propose([phase]);
  store.sendBack(id, phase.key, { author: 'Por', body: 'Try again' });
  const code = issueApproveCode(store, id, start);
  await success('resubmit', { proposal: id, nodes: [{ ...phase, title: 'Revised phase' }] });
  await error('approve', { proposal: id, code }, /no approve code/i);
  assert.equal(store.getProposal(id)!.nodes[0]!.status, 'draft');
});

it('migrates existing codes from schema 3 and persists the attempt count across connections', t => {
  const dir = mkdtempSync(join(tmpdir(), 'orchid-proposals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = dbPath(dir);
  const legacy = openStore(path);
  const { id } = legacy.createProposal({ nodes: [{ ...phase, type: 'Phase' }] });
  legacy.saveApproveCode(id, 'LEGACY', new Date(start.getTime() + 60_000), start);
  legacy.db.exec("ALTER TABLE approve_codes DROP COLUMN failed_attempts; UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  legacy.close();

  const first = openStore(path);
  const second = openStore(path);
  try {
    assert.equal(schemaVersion(first.db), 4);
    for (const store of [first, second, first, second]) {
      assert.deepEqual(store.consumeApproveCode(id, 'invalid', start), { ok: false, reason: 'wrong' });
    }
    assert.deepEqual(first.consumeApproveCode(id, 'invalid', start), { ok: false, reason: 'locked' });
    assert.deepEqual(second.consumeApproveCode(id, 'LEGACY', start), { ok: false, reason: 'locked' });
    const fresh = issueApproveCode(first, id, start);
    assert.deepEqual(second.consumeApproveCode(id, fresh, start), { ok: true });
  } finally {
    first.close();
    second.close();
  }
});
