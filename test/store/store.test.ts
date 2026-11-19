import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from '../../src/store/db.ts';
import { ClaimConflictError, needsYou, Store, StoreError, underReview, type IssueInput, type TreeNode } from '../../src/store/store.ts';

const T0 = new Date('2026-11-18T10:00:00.000Z');
const MIN = 60_000;
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * MIN);

function newStore(): Store {
  return new Store(openDb(':memory:'), { now: () => T0 });
}

const REPO = 'companie-apps/orchid-board';
const SPRINT_1 = { id: 'it1', title: 'Sprint 1' };
const SPRINT_2 = { id: 'it2', title: 'Sprint 2' };

function issue(number: number, fields: Partial<IssueInput> = {}): IssueInput {
  return {
    ref: `${REPO}#${number}`,
    nodeId: `I_${number}`,
    type: 'Task',
    title: `Issue ${number}`,
    state: 'open',
    parent: null,
    iteration: null,
    updatedAt: '2026-11-18T09:00:00Z',
    ...fields,
  };
}

const refs = (nodes: TreeNode[]): string[] => nodes.map((node) => node.ref);

function seedTree(store: Store): void {
  store.upsertIssues([
    issue(1, { type: 'Phase' }),
    issue(2, { type: 'Feature', parent: `${REPO}#1` }),
    issue(3, { parent: `${REPO}#2`, iteration: SPRINT_1 }),
    issue(4, { parent: `${REPO}#2`, iteration: SPRINT_2, state: 'closed' }),
    // Cross-repo task under the same feature.
    issue(1, { ref: 'companie-apps/other#1', nodeId: 'O_1', parent: `${REPO}#2`, iteration: SPRINT_1 }),
    // Orphans: no type, and a parent that is not in the DB.
    issue(5, { type: null }),
    issue(6, { parent: `${REPO}#999` }),
    // Child of a typeless issue.
    issue(7, { parent: `${REPO}#5` }),
  ]);
}

describe('issues', () => {
  it('upserts and reads back', () => {
    const store = newStore();
    store.upsertIssue(issue(3, { iteration: SPRINT_1 }));
    store.upsertIssue(issue(3, { title: 'Renamed', state: 'closed', iteration: null }));
    assert.deepEqual(store.getIssue(`${REPO}#3`), {
      ...issue(3, { title: 'Renamed', state: 'closed' }),
      repo: REPO,
      number: 3,
    });
    assert.equal(store.getIssue(`${REPO}#4`), null);
  });

  it('moves a transferred issue (same node_id, new ref)', () => {
    const store = newStore();
    store.upsertIssue(issue(3));
    store.upsertIssue(issue(9, { ref: 'companie-apps/other#9', nodeId: 'I_3' }));
    assert.equal(store.getIssue(`${REPO}#3`), null);
    assert.equal(store.getIssue('companie-apps/other#9')?.nodeId, 'I_3');
  });

  it('rejects bad refs', () => {
    const store = newStore();
    assert.throws(() => store.upsertIssue(issue(1, { ref: 'nope#1' })));
    assert.throws(() => store.upsertIssue(issue(1, { parent: 'nope' })), StoreError);
  });
});

describe('getTree', () => {
  it('nests Phase → Feature → Task and keeps orphans', () => {
    const store = newStore();
    seedTree(store);
    const tree = store.getTree();
    assert.deepEqual(refs(tree.roots), [`${REPO}#1`]);
    const feature = tree.roots[0]!.children[0]!;
    assert.equal(feature.ref, `${REPO}#2`);
    assert.deepEqual(refs(feature.children), [`${REPO}#3`, `${REPO}#4`, 'companie-apps/other#1']);
    assert.deepEqual(refs(tree.orphans), [`${REPO}#5`, `${REPO}#6`]);
    assert.deepEqual(refs(tree.orphans[0]!.children), [`${REPO}#7`]);
  });

  it('filters by iteration and state, keeping ancestors', () => {
    const store = newStore();
    seedTree(store);
    const tree = store.getTree({ iteration: 'Sprint 1' });
    assert.deepEqual(refs(tree.roots), [`${REPO}#1`]);
    assert.deepEqual(refs(tree.roots[0]!.children[0]!.children), [`${REPO}#3`, 'companie-apps/other#1']);
    assert.deepEqual(tree.orphans, []);

    const byId = store.getTree({ iteration: 'it2' });
    assert.deepEqual(refs(byId.roots[0]!.children[0]!.children), [`${REPO}#4`]);

    const open = store.getTree({ state: 'open' });
    assert.deepEqual(refs(open.roots[0]!.children[0]!.children), [`${REPO}#3`, 'companie-apps/other#1']);
  });

  it('filters by repo, keeping cross-repo ancestors', () => {
    const store = newStore();
    seedTree(store);
    const tree = store.getTree({ repo: 'companie-apps/other' });
    assert.deepEqual(refs(tree.roots), [`${REPO}#1`]);
    assert.deepEqual(refs(tree.roots[0]!.children[0]!.children), ['companie-apps/other#1']);
  });

  it('attaches PRs with checks and active claims', () => {
    const store = newStore();
    seedTree(store);
    store.upsertPr({
      ref: `${REPO}#20`,
      url: 'https://github.com/companie-apps/orchid-board/pull/20',
      title: 'Store',
      state: 'open',
      draft: true,
      issues: [`${REPO}#3`],
      updatedAt: '2026-11-18T09:30:00Z',
      checks: 'running',
    });
    store.claim(`${REPO}#3`, 'agent-a', { ttlMs: 30 * MIN });
    const task = store.getTree().roots[0]!.children[0]!.children.find((node) => node.number === 3)!;
    assert.equal(task.claim?.agent, 'agent-a');
    assert.equal(task.prs.length, 1);
    assert.equal(task.prs[0]!.checks, 'running');
    assert.equal(task.prs[0]!.draft, true);
  });

  it('survives a parent cycle', () => {
    const store = newStore();
    store.upsertIssues([issue(1, { type: 'Feature', parent: `${REPO}#2` }), issue(2, { parent: `${REPO}#1` })]);
    const tree = store.getTree({ state: 'open' });
    assert.deepEqual(refs(tree.orphans), [`${REPO}#1`]);
    assert.deepEqual(refs(tree.orphans[0]!.children), [`${REPO}#2`]);
  });
});

describe('prs', () => {
  it('replaces links and keeps checks unless given', () => {
    const store = newStore();
    const base = {
      ref: `${REPO}#20`,
      url: 'https://github.com/companie-apps/orchid-board/pull/20',
      title: 'Store',
      state: 'open' as const,
      draft: false,
      updatedAt: '2026-11-18T09:30:00Z',
    };
    store.upsertPr({ ...base, issues: [`${REPO}#3`, `${REPO}#4`] });
    assert.equal(store.getPr(base.ref)?.checks, 'none');
    store.setChecks(base.ref, 'fail');
    store.upsertPr({ ...base, state: 'merged', issues: [`${REPO}#4`] });
    const pr = store.getPr(base.ref)!;
    assert.equal(pr.state, 'merged');
    assert.equal(pr.checks, 'fail');
    assert.deepEqual(pr.issues, [`${REPO}#4`]);
    assert.deepEqual(store.prsForIssue(`${REPO}#3`), []);
    assert.equal(store.prsForIssue(`${REPO}#4`).length, 1);
    assert.equal(store.deletePr(base.ref), true);
    assert.equal(store.getPr(base.ref), null);
  });
});

describe('claims', () => {
  const task = `${REPO}#3`;

  it('throws naming the holder when another agent claims', () => {
    const store = newStore();
    store.claim(task, 'agent-a', { ttlMs: 30 * MIN });
    assert.throws(
      () => store.claim(task, 'agent-b', { ttlMs: 30 * MIN, now: at(10) }),
      (err: unknown) => err instanceof ClaimConflictError && err.holder === 'agent-a' && err.message.includes('agent-a'),
    );
  });

  it('renews for the same agent and keeps since', () => {
    const store = newStore();
    store.claim(task, 'agent-a', { ttlMs: 30 * MIN });
    const renewed = store.claim(task, 'agent-a', { ttlMs: 30 * MIN, now: at(20) });
    assert.equal(renewed.since, T0.toISOString());
    assert.equal(renewed.expiresAt, at(50).toISOString());
  });

  it('lets another agent take an expired claim', () => {
    const store = newStore();
    store.claim(task, 'agent-a', { ttlMs: 30 * MIN });
    assert.equal(store.getClaim(task, at(30)), null);
    assert.deepEqual(store.listClaims(at(30)), []);
    const taken = store.claim(task, 'agent-b', { ttlMs: 30 * MIN, now: at(31) });
    assert.equal(taken.agent, 'agent-b');
    assert.equal(taken.since, at(31).toISOString());
  });

  it('purges expired claims', () => {
    const store = newStore();
    store.claim(task, 'agent-a', { ttlMs: 10 * MIN });
    store.claim(`${REPO}#4`, 'agent-b', { ttlMs: 60 * MIN });
    assert.equal(store.purgeExpiredClaims(at(15)), 1);
    assert.deepEqual(
      store.listClaims(at(15)).map((claim) => claim.task),
      [`${REPO}#4`],
    );
  });

  it('release checks the holder when an agent is given', () => {
    const store = newStore();
    store.claim(task, 'agent-a', { ttlMs: 30 * MIN });
    assert.throws(() => store.release(task, 'agent-b'), ClaimConflictError);
    assert.equal(store.release(task, 'agent-a'), true);
    assert.equal(store.release(task), false);
    assert.equal(store.getClaim(task), null);
  });
});

describe('proposals', () => {
  const nodes = [
    { key: 'f', repo: REPO, type: 'Feature' as const, title: 'MCP', branch: 'feature/mcp/mcp' },
    { key: 't1', parentKey: 'f', repo: REPO, type: 'Task' as const, title: 'Signal', branch: 'feature/mcp/signal' },
    { key: 't2', parentKey: 'f', repo: REPO, type: 'Task' as const, title: 'Write', iteration: 'Sprint 2' },
  ];

  it('stores a draft tree in order', () => {
    const store = newStore();
    const proposal = store.createProposal({ parent: `${REPO}#1`, agent: 'agent-a', nodes });
    assert.equal(proposal.state, 'pending');
    assert.equal(proposal.parent, `${REPO}#1`);
    assert.deepEqual(
      proposal.nodes.map((node) => [node.key, node.parentKey, node.position, node.status, node.branch]),
      [
        ['f', null, 0, 'draft', 'feature/mcp/mcp'],
        ['t1', 'f', 1, 'draft', 'feature/mcp/signal'],
        ['t2', 'f', 2, 'draft', null],
      ],
    );
    assert.deepEqual(
      store.listProposals('pending').map((p) => p.id),
      [proposal.id],
    );
  });

  it('rejects duplicate keys and parents that come later', () => {
    const store = newStore();
    assert.throws(() => store.createProposal({ nodes: [nodes[0]!, nodes[0]!] }), StoreError);
    assert.throws(() => store.createProposal({ nodes: [nodes[1]!, nodes[0]!] }), StoreError);
    assert.throws(() => store.createProposal({ nodes: [] }), StoreError);
  });

  it('round-trips feedback and resubmits only sent-back nodes', () => {
    const store = newStore();
    const { id } = store.createProposal({ nodes });
    store.sendBack(id, 't2', { author: 'por', body: 'split this' }, at(5));
    store.addFeedback(id, null, 'por', 'otherwise fine', at(6));
    const feedback = store.getFeedback(id);
    assert.deepEqual(
      feedback.sentBack.map((node) => node.key),
      ['t2'],
    );
    assert.deepEqual(
      feedback.comments.map((c) => [c.nodeKey, c.body]),
      [
        ['t2', 'split this'],
        [null, 'otherwise fine'],
      ],
    );

    assert.throws(() => store.resubmitNodes(id, [{ ...nodes[1]!, title: 'x' }]), StoreError);
    const after = store.resubmitNodes(id, [{ ...nodes[2]!, title: 'Write v2' }], at(7));
    const t2 = after.nodes.find((node) => node.key === 't2')!;
    assert.equal(t2.title, 'Write v2');
    assert.equal(t2.status, 'draft');
    assert.equal(t2.parentKey, 'f');
    assert.equal(after.updatedAt, at(7).toISOString());
  });

  it('records created issues idempotently', () => {
    const store = newStore();
    const { id } = store.createProposal({ nodes });
    store.setProposalState(id, 'approved');
    store.recordCreatedIssue(id, 'f', { number: 30, nodeId: 'I_30' });
    store.recordCreatedIssue(id, 'f', { number: 30, nodeId: 'I_30' });
    assert.throws(() => store.recordCreatedIssue(id, 'f', { number: 31, nodeId: 'I_31' }), StoreError);
    const f = store.getProposal(id)!.nodes[0]!;
    assert.equal(f.status, 'created');
    assert.equal(f.issueNumber, 30);
    assert.equal(f.issueNodeId, 'I_30');
    assert.equal(store.getProposal(id)!.state, 'approved');
  });
});

describe('needsYou', () => {
  const first = { key: 'a', repo: REPO, type: 'Task', title: 'First task' } as const;
  const second = { ...first, key: 'b', title: 'Second task' };

  it('counts pending proposals until all items are sent back and counts them again after resubmission', () => {
    const store = newStore();
    const { id } = store.createProposal({ nodes: [first, second] });
    const feedback = { author: 'por', body: 'Split this' };
    store.sendBack(id, first.key, feedback);
    assert.equal(needsYou(store.getProposal(id)!), true);

    store.sendBack(id, second.key, feedback);
    const waiting = store.getProposal(id)!;
    assert.equal(needsYou(waiting), false);
    assert.equal(underReview(waiting), true);

    assert.equal(needsYou(store.resubmitNodes(id, [first])), true);
  });

  it('excludes draft descendants of a sent-back parent', () => {
    const store = newStore();
    const parent = { key: 'p', repo: REPO, type: 'Phase', title: 'Phase' } as const;
    const feature = { key: 'f', parentKey: parent.key, repo: REPO, type: 'Feature', title: 'Feature' } as const;
    const { id } = store.createProposal({ nodes: [parent, feature, { ...first, parentKey: feature.key }] });
    store.sendBack(id, parent.key, { author: 'por', body: 'Revise the scope' });
    assert.equal(needsYou(store.getProposal(id)!), false);
  });

  it('counts withheld drafts after approval and after writing, and excludes rejected proposals', () => {
    const store = newStore();
    const { id } = store.createProposal({ nodes: [first, second] });
    store.saveApproveCode(id, 'K7Q2', at(10));
    assert.deepEqual(store.approveProposal(id, 'K7Q2', at(1), { withhold: [second.key] }), { ok: true });
    assert.equal(needsYou(store.getProposal(id)!), true);

    store.recordCreatedIssue(id, first.key, { number: 30, nodeId: 'I_30' });
    store.setProposalState(id, 'done', at(2));
    assert.equal(needsYou(store.getProposal(id)!), true);

    store.setProposalState(id, 'rejected', at(3));
    assert.equal(needsYou(store.getProposal(id)!), false);
  });
});

describe('approve codes', () => {
  function withCode(): { store: Store; id: string } {
    const store = newStore();
    const { id } = store.createProposal({ nodes: [{ key: 'p', repo: REPO, type: 'Phase', title: 'P' }] });
    store.saveApproveCode(id, 'K7Q2', at(10));
    return { store, id };
  }

  it('stores only a hash', () => {
    const { store } = withCode();
    const row = store.db.prepare('SELECT code_hash FROM approve_codes').get()!;
    assert.notEqual(row.code_hash, 'K7Q2');
    assert.match(String(row.code_hash), /^[0-9a-f]{64}$/);
  });

  it('succeeds once, and a wrong guess does not burn it', () => {
    const { store, id } = withCode();
    assert.deepEqual(store.consumeApproveCode(id, 'WRNG', at(1)), { ok: false, reason: 'wrong' });
    assert.deepEqual(store.consumeApproveCode(id, 'K7Q2', at(2)), { ok: true });
    assert.deepEqual(store.consumeApproveCode(id, 'K7Q2', at(3)), { ok: false, reason: 'used' });
  });

  it('fails when expired or missing', () => {
    const { store, id } = withCode();
    assert.deepEqual(store.consumeApproveCode(id, 'K7Q2', at(10)), { ok: false, reason: 'expired' });
    assert.deepEqual(store.consumeApproveCode('prop_missing', 'K7Q2', at(1)), { ok: false, reason: 'missing' });
  });

  it('a new code replaces the old one', () => {
    const { store, id } = withCode();
    assert.deepEqual(store.consumeApproveCode(id, 'K7Q2', at(1)), { ok: true });
    store.saveApproveCode(id, 'ZZ99', at(20), at(2));
    assert.deepEqual(store.consumeApproveCode(id, 'K7Q2', at(3)), { ok: false, reason: 'wrong' });
    assert.deepEqual(store.consumeApproveCode(id, 'ZZ99', at(3)), { ok: true });
  });

  it('does not accept a code issued for another proposal', () => {
    const { store, id } = withCode();
    const other = store.createProposal({ nodes: [{ key: 'p', repo: REPO, type: 'Phase', title: 'Q' }] });
    store.saveApproveCode(other.id, 'AAAA', at(10));
    assert.deepEqual(store.consumeApproveCode(id, 'AAAA', at(1)), { ok: false, reason: 'wrong' });
  });
});
