import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectRef } from '../../src/config.ts';
import { GitHubClient } from '../../src/github/client.ts';
import { issueApproveCode } from '../../src/proposals/approve-code.ts';
import { proposalTools } from '../../src/proposals/tools.ts';
import { ProposalWriter, writeMarker } from '../../src/proposals/writer.ts';
import { Secret } from '../../src/secrets.ts';
import { openStore, type ProposalNodeInput, type Store } from '../../src/store/store.ts';

const ORG = 'companie-apps';
const BOARD = `${ORG}/orchid-board`;
const OTHER = `${ORG}/orchid-web`;
const TOKEN = 'ghp_fake_write_token';
const LOGIN = 'orchid-bot';
const PROJECT: ProjectRef = { owner: ORG, number: 3 };

interface FakeIssue {
  id: string;
  number: number;
  repo: string;
  title: string;
  body: string;
  author: string;
  typeId: string | null;
  parentId: string | null;
  items: { id: string; projectId: string; iterationId: string | null }[];
}

type Variables = Record<string, unknown>;
/** Return a Response to replace the normal reply; `after` runs the operation first, then replies with it. */
type Fault = (op: string, variables: Variables) => { response: Response; after?: boolean } | undefined;

class FakeGitHub {
  types: { id: string; name: string }[] | null = [
    { id: 'IT_phase', name: 'Phase' }, { id: 'IT_feature', name: 'Feature' }, { id: 'IT_task', name: 'Task' },
  ];
  readonly repos = new Map([[BOARD, 'R_board'], [OTHER, 'R_web']]);
  readonly issues: FakeIssue[] = [];
  readonly calls: string[] = [];
  readonly iterations = [{ id: 'iter_1', title: 'Sprint 1' }];
  readonly completed = [{ id: 'iter_0', title: 'Sprint 0' }];
  fault?: Fault;

  readonly fetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Variables };
    const op = /(?:query|mutation) (\w+)/.exec(request.query)?.[1];
    assert.ok(op, 'every write-path request is a named operation');
    this.calls.push(op);
    assert.ok(!JSON.stringify(request).includes(TOKEN), 'token never in a request body');
    const fault = this.fault?.(op, request.variables);
    if (fault && !fault.after) return fault.response;
    const data = this.#handle(op, request.variables);
    return fault?.response ?? Response.json({ data });
  };

  issue(id: string): FakeIssue {
    const issue = this.issues.find(candidate => candidate.id === id);
    assert.ok(issue, `no fake issue ${id}`);
    return issue;
  }

  byTitle(title: string): FakeIssue {
    const issue = this.issues.find(candidate => candidate.title === title);
    assert.ok(issue, `no fake issue titled ${title}`);
    return issue;
  }

  count(op: string): number {
    return this.calls.filter(call => call === op).length;
  }

  #handle(op: string, v: Variables): unknown {
    switch (op) {
      case 'WriteRepo': {
        const id = this.repos.get(`${v.owner}/${v.name}`);
        if (!id) return { repository: null };
        return { repository: { id, owner: this.types ? { issueTypes: { nodes: this.types } } : {} } };
      }
      case 'WriteViewer':
        return { viewer: { login: LOGIN } };
      case 'WriteFindMarker': {
        const repo = `${v.owner}/${v.name}`;
        const nodes = this.issues.filter(issue => issue.repo === repo && issue.author === v.login).reverse()
          .map(({ id, number, body }) => ({ id, number, body }));
        return { repository: { issues: { nodes } } };
      }
      case 'WriteCreateIssue': {
        const input = v.input as { repositoryId: string; title: string; body: string; issueTypeId: string };
        const repo = [...this.repos].find(([, id]) => id === input.repositoryId)![0];
        const number = 100 + this.issues.filter(issue => issue.repo === repo).length;
        const issue: FakeIssue = {
          id: `I_${repo.split('/')[1]}_${number}`, number, repo, title: input.title, body: input.body, author: LOGIN,
          typeId: input.issueTypeId, parentId: null, items: [],
        };
        this.issues.push(issue);
        return { createIssue: { issue: { id: issue.id, number } } };
      }
      case 'WriteIssueId': {
        const issue = this.issues.find(found => found.repo === `${v.owner}/${v.name}` && found.number === v.number);
        return { repository: { issue: issue ? { id: issue.id } : null } };
      }
      case 'WriteIssueState': {
        const issue = this.issue(String(v.id));
        return {
          node: {
            id: issue.id, number: issue.number,
            issueType: issue.typeId ? { id: issue.typeId } : null,
            parent: issue.parentId ? { id: issue.parentId } : null,
            projectItems: {
              nodes: issue.items.map(item => ({
                id: item.id, project: { id: item.projectId },
                fieldValueByName: item.iterationId ? { iterationId: item.iterationId } : null,
              })),
            },
          },
        };
      }
      case 'WriteSetIssueType':
        this.issue(String(v.id)).typeId = String(v.issueTypeId);
        return { updateIssue: { issue: { id: v.id } } };
      case 'WriteAddSubIssue': {
        const child = this.issue(String(v.childId));
        assert.equal(child.parentId, null, 'GitHub rejects a second parent');
        child.parentId = String(v.parentId);
        return { addSubIssue: { issue: { id: v.parentId } } };
      }
      case 'WriteProject':
        assert.deepEqual(v, { owner: PROJECT.owner, number: PROJECT.number });
        return {
          repositoryOwner: {
            projectV2: {
              id: 'PVT_3',
              field: { id: 'F_iter', configuration: { iterations: this.iterations, completedIterations: this.completed } },
            },
          },
        };
      case 'WriteAddProjectItem': {
        const issue = this.issue(String(v.contentId));
        let item = issue.items.find(found => found.projectId === v.projectId);
        if (!item) issue.items.push(item = { id: `PVTI_${issue.id}`, projectId: String(v.projectId), iterationId: null });
        return { addProjectV2ItemById: { item: { id: item.id } } };
      }
      case 'WriteSetIteration': {
        const item = this.issues.flatMap(issue => issue.items).find(found => found.id === v.itemId);
        assert.ok(item);
        assert.equal(v.fieldId, 'F_iter');
        item.iterationId = String(v.iterationId);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } };
      }
      default:
        assert.fail(`unexpected operation ${op}`);
    }
  }
}

function setup(t: TestContext, options: { project?: ProjectRef | null } = {}) {
  const store = openStore(':memory:');
  const github = new FakeGitHub();
  const token = new Secret('github.token', TOKEN);
  const client = new GitHubClient(token, { fetch: github.fetch, sleep: async () => {} });
  const written: string[][] = [];
  const errors: string[] = [];
  const writer = new ProposalWriter({
    store, client, project: options.project === undefined ? PROJECT : options.project, secrets: [token],
    onWritten: repos => { written.push(repos.sort()); },
    onError: (_id, message) => { errors.push(message); },
    retryDelayMs: () => 3_600_000,
  });
  t.after(async () => {
    await writer.stop();
    store.close();
  });
  return { store, github, writer, written, errors };
}

function approved(store: Store, nodes: ProposalNodeInput[], options: { parent?: string; sendBack?: string[] } = {}): string {
  const proposal = store.createProposal({ agent: 'claude', parent: options.parent ?? null, nodes });
  for (const key of options.sendBack ?? []) store.sendBack(proposal.id, key, { author: 'por', body: 'rework' });
  store.saveApproveCode(proposal.id, 'CODE42', new Date(Date.now() + 60_000));
  assert.deepEqual(store.approveProposal(proposal.id, 'CODE42'), { ok: true });
  return proposal.id;
}

const TREE: ProposalNodeInput[] = [
  { key: 'phase', repo: BOARD, type: 'Phase', title: 'Phase 2', body: 'Ship the writer.' },
  { key: 'feature', parentKey: 'phase', repo: BOARD, type: 'Feature', title: 'MCP', branch: 'feature/mcp/mcp' },
  {
    key: 'task-a', parentKey: 'feature', repo: OTHER, type: 'Task', title: 'Write', body: 'Create issues.',
    branch: 'feature/mcp/write', iteration: 'sprint 1',
  },
  { key: 'task-b', parentKey: 'feature', repo: BOARD, type: 'Task', title: 'Old', branch: 'feature/mcp/old', iteration: 'iter_0' },
  { key: 'task-c', parentKey: 'feature', repo: BOARD, type: 'Task', title: 'Later', branch: 'feature/mcp/later', iteration: 'Sprint 9' },
];

function nodeOf(store: Store, id: string, key: string) {
  return store.getProposal(id)!.nodes.find(node => node.key === key)!;
}

it('creates a 3-level tree with types, sub-issue links, project items and iterations', async (t) => {
  const { store, github, writer, written, errors } = setup(t);
  const id = approved(store, TREE);

  await writer.kick(id);

  assert.deepEqual(errors, []);
  assert.equal(store.getProposal(id)!.state, 'done');
  const phase = github.byTitle('Phase 2');
  const feature = github.byTitle('MCP');
  const taskA = github.byTitle('Write');
  const taskB = github.byTitle('Old');
  const taskC = github.byTitle('Later');
  assert.equal(github.issues.length, 5);
  // Parents first, each in its own repo.
  assert.deepEqual(github.issues.map(issue => issue.title), ['Phase 2', 'MCP', 'Write', 'Old', 'Later']);
  assert.equal(taskA.repo, OTHER);
  assert.deepEqual([phase.typeId, feature.typeId, taskA.typeId], ['IT_phase', 'IT_feature', 'IT_task']);
  assert.equal(phase.parentId, null);
  assert.equal(feature.parentId, phase.id);
  assert.deepEqual([taskA.parentId, taskB.parentId, taskC.parentId], [feature.id, feature.id, feature.id]);
  for (const issue of github.issues) assert.deepEqual(issue.items.map(item => item.projectId), ['PVT_3']);
  // Title match ignores case; completed iterations match by id; an unknown one is skipped with a warning.
  assert.equal(taskA.items[0]!.iterationId, 'iter_1');
  assert.equal(taskB.items[0]!.iterationId, 'iter_0');
  assert.equal(taskC.items[0]!.iterationId, null);
  assert.equal(taskA.body, 'Create issues.\n\nBranch: `feature/mcp/write`\n\n' + writeMarker(id, 'task-a'));
  assert.equal(phase.body, 'Ship the writer.\n\n' + writeMarker(id, 'phase'));

  for (const node of store.getProposal(id)!.nodes) {
    assert.equal(node.status, 'created');
    const issue = github.issues.find(found => found.id === node.issueNodeId)!;
    assert.equal(node.issueNumber, issue.number);
  }
  const status = writer.status(id);
  assert.equal(status.error, null);
  assert.equal(status.running, false);
  assert.deepEqual(status.warnings, [`no iteration "Sprint 9" in the project; ${BOARD}#${taskC.number} was added without one`]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written, [[OTHER, BOARD].sort()]);
  // No marker lookups on the happy path, and a finished proposal is left alone.
  assert.equal(github.count('WriteFindMarker'), 0);
  const calls = github.calls.length;
  await writer.kick(id);
  assert.equal(github.calls.length, calls);
});

it('attaches the top nodes under the proposal parent and skips the project when none is configured', async (t) => {
  const { store, github, writer } = setup(t, { project: null });
  github.issues.push({
    id: 'I_existing', number: 7, repo: BOARD, title: 'Existing feature', body: '', author: 'por',
    typeId: 'IT_feature', parentId: null, items: [],
  });
  store.upsertIssue({
    ref: `${BOARD}#7`, nodeId: 'I_existing', type: 'Feature', title: 'Existing feature', state: 'open',
    parent: null, iteration: null, updatedAt: '2026-11-18T00:00:00Z',
  });
  const id = approved(store, [
    { key: 't1', repo: BOARD, type: 'Task', title: 'One', branch: 'feature/existing-feature/one', iteration: 'Sprint 1' },
  ], { parent: `${BOARD}#7` });

  await writer.kick(id);

  assert.equal(store.getProposal(id)!.state, 'done');
  assert.equal(github.byTitle('One').parentId, 'I_existing');
  assert.equal(github.count('WriteProject'), 0);
  assert.equal(github.count('WriteIssueId'), 0);
});

it('resumes after a failure mid-tree without creating duplicates', async (t) => {
  const { store, github, writer, errors } = setup(t);
  const id = approved(store, TREE);
  github.fault = (op, v) => op === 'WriteAddSubIssue' && v.childId === github.issues[1]?.id
    ? { response: Response.json({ message: `Server Error for ${TOKEN}` }, { status: 500 }) }
    : undefined;

  await writer.kick(id);

  // A 5xx on a mutation is not retried: the write may have happened.
  assert.equal(github.count('WriteAddSubIssue'), 1);
  assert.equal(github.issues.length, 2);
  const proposal = store.getProposal(id)!;
  assert.equal(proposal.state, 'approved');
  assert.deepEqual(proposal.nodes.map(node => node.status), ['created', 'created', 'approved', 'approved', 'approved']);
  const status = writer.status(id);
  assert.match(status.error!, /node "feature".*GitHub HTTP 500/);
  assert.ok(!status.error!.includes(TOKEN), 'error is redacted');
  assert.ok(!errors.join('\n').includes(TOKEN));
  assert.equal(status.failures, 1);
  assert.ok(status.retryAt);

  github.fault = undefined;
  await writer.kick(id);

  assert.equal(store.getProposal(id)!.state, 'done');
  assert.equal(github.issues.length, 5);
  assert.equal(github.count('WriteCreateIssue'), 5);
  assert.equal(github.byTitle('MCP').parentId, github.byTitle('Phase 2').id);
  assert.deepEqual(writer.status(id), { ...writer.status(id), error: null, failures: 0, retryAt: null });
});

it('adopts an issue created just before a crash by its body marker', async (t) => {
  const { store, github, writer } = setup(t);
  const id = approved(store, TREE);
  // GitHub creates the Task, then the reply is lost as a 502.
  github.fault = (op, v) => op === 'WriteCreateIssue' && (v.input as { title: string }).title === 'Write'
    ? { response: new Response('bad gateway', { status: 502 }), after: true }
    : undefined;

  await writer.kick(id);

  assert.equal(github.count('WriteCreateIssue'), 3);
  assert.equal(github.issues.length, 3);
  assert.equal(nodeOf(store, id, 'task-a').issueNumber, null);
  assert.match(writer.status(id).error!, /node "task-a".*GitHub HTTP 502/);

  github.fault = undefined;
  await writer.kick(id);

  assert.equal(store.getProposal(id)!.state, 'done');
  assert.equal(github.issues.length, 5, 'no duplicate for the lost reply');
  assert.equal(github.count('WriteFindMarker'), 1);
  const adopted = github.byTitle('Write');
  assert.equal(nodeOf(store, id, 'task-a').issueNumber, adopted.number);
  assert.equal(nodeOf(store, id, 'task-a').issueNodeId, adopted.id);
  assert.equal(adopted.parentId, github.byTitle('MCP').id);
  assert.equal(adopted.items[0]!.iterationId, 'iter_1');
});

it('creates a node again when its marker is not found after a failed attempt', async (t) => {
  const { store, github, writer } = setup(t, { project: null });
  const id = approved(store, TREE.slice(0, 1));
  github.fault = op => op === 'WriteCreateIssue' ? { response: new Response('bad gateway', { status: 502 }) } : undefined;
  await writer.kick(id);
  assert.equal(github.issues.length, 0);

  github.fault = undefined;
  await writer.kick(id);
  assert.equal(github.count('WriteFindMarker'), 1);
  assert.equal(github.issues.length, 1);
  assert.equal(store.getProposal(id)!.state, 'done');
});

it('skips a sent-back subtree and finishes the rest', async (t) => {
  const { store, github, writer } = setup(t, { project: null });
  const id = approved(store, [
    { key: 'phase', repo: BOARD, type: 'Phase', title: 'Phase' },
    { key: 'f-back', parentKey: 'phase', repo: BOARD, type: 'Feature', title: 'Sent back', branch: 'feature/a/a' },
    { key: 't-wait', parentKey: 'f-back', repo: BOARD, type: 'Task', title: 'Waiting', branch: 'feature/a/w' },
    { key: 'f-ok', parentKey: 'phase', repo: BOARD, type: 'Feature', title: 'Approved', branch: 'feature/b/b' },
    { key: 't-ok', parentKey: 'f-ok', repo: BOARD, type: 'Task', title: 'Go', branch: 'feature/b/go' },
  ], { sendBack: ['f-back'] });

  await writer.kick(id);

  assert.deepEqual(github.issues.map(issue => issue.title), ['Phase', 'Approved', 'Go']);
  const proposal = store.getProposal(id)!;
  assert.equal(proposal.state, 'done');
  assert.deepEqual(
    Object.fromEntries(proposal.nodes.map(node => [node.key, node.status])),
    { phase: 'created', 'f-back': 'sent_back', 't-wait': 'draft', 'f-ok': 'created', 't-ok': 'created' },
  );
});

it('fails clearly before any write when an issue type is missing, then recovers', async (t) => {
  const { store, github, writer } = setup(t);
  github.types = github.types!.filter(type => type.name !== 'Task');
  const id = approved(store, TREE);

  await writer.kick(id);

  assert.equal(github.issues.length, 0);
  assert.ok(github.calls.every(call => !/^Write(Create|Set|Add)/.test(call)), 'no mutation was sent');
  assert.match(writer.status(id).error!, /issue type "Task" is missing in the companie-apps organization/);
  assert.equal(store.getProposal(id)!.state, 'approved');

  github.types = [...github.types, { id: 'IT_task', name: 'Task' }];
  await writer.kick(id);
  assert.equal(store.getProposal(id)!.state, 'done');
  assert.equal(github.issues.length, 5);
});

it('resumeAll picks up approved proposals and leaves others alone', async (t) => {
  const { store, github, writer } = setup(t, { project: null });
  const id = approved(store, TREE.slice(0, 1));
  const pending = store.createProposal({ agent: 'claude', nodes: [{ key: 'p', repo: BOARD, type: 'Phase', title: 'Pending' }] });

  await writer.resumeAll();

  assert.equal(store.getProposal(id)!.state, 'done');
  assert.equal(store.getProposal(pending.id)!.state, 'pending');
  assert.deepEqual(github.issues.map(issue => issue.title), ['Phase 2']);
});

it('the approve tool starts the write and get_proposal reports progress', async (t) => {
  const { store, github, writer } = setup(t, { project: null });
  const server = new McpServer({ name: 'orchid-board', version: 'test' });
  proposalTools({ store, repos: [{ owner: ORG, name: 'orchid-board' }], writer })(server);
  const client = new Client({ name: 'writer-test', version: 'test' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(Array.isArray(result.content));
    assert.ok(!result.isError, JSON.stringify(result.content));
    return JSON.parse((result.content[0] as { text: string }).text);
  };

  const proposal = await call('propose_tree', {
    agent: 'claude',
    nodes: [{ key: 'p', type: 'Phase', repo: BOARD, title: 'Phase', children: [{ key: 'f', type: 'Feature', repo: BOARD, title: 'Board UI' }] }],
  });
  const code = issueApproveCode(store, proposal.id);
  assert.deepEqual(await call('approve', { proposal: proposal.id, code }), {
    proposal: proposal.id, state: 'approved', write: 'started (see get_proposal)',
  });
  await writer.kick(proposal.id);

  const view = await call('get_proposal', { proposal: proposal.id });
  assert.equal(view.state, 'done');
  assert.deepEqual(view.nodes.map((node: { issue: string }) => node.issue), [`${BOARD}#100`, `${BOARD}#101`]);
  assert.equal(view.nodes[1].branch, 'feature/board-ui/board-ui');
  assert.deepEqual({ running: view.write.running, error: view.write.error }, { running: false, error: null });
  assert.match(github.byTitle('Board UI').body, /Branch: `feature\/board-ui\/board-ui`/);
});

it('writes inbox detail edits and holds withheld items until a later approval', async (t) => {
  const { store, github, writer, errors } = setup(t);
  const id = store.createProposal({ agent: 'claude', nodes: TREE }).id;
  // Por's edits in the inbox details pane, saved before approval.
  store.renameProposalNode(id, 'task-a', 'Write issues');
  store.updateProposalNodeDetails(id, 'task-a', {
    body: 'Create issues in order.', steps: ['Parents first', ' ', 'Link sub-issues'],
    baseBranch: 'feature/mcp/mcp', dependsOn: '#old', iteration: 'iter_0',
  });
  store.setDraftNote(id, 'task-c', 'Not yet');
  // Withhold task-c: it stays a draft while the rest is written.
  store.saveApproveCode(id, 'CODE42', new Date(Date.now() + 60_000));
  assert.deepEqual(store.approveProposal(id, 'CODE42', new Date(), { withhold: ['task-c'] }), { ok: true });
  await writer.kick(id);

  assert.deepEqual(errors, []);
  const taskA = github.byTitle('Write issues');
  assert.equal(taskA.body, [
    'Create issues in order.',
    '## Steps\n\n- [ ] Parents first\n- [ ] Link sub-issues',
    'Branch: `feature/mcp/write`',
    'Base: `feature/mcp/mcp`',
    'Depends on: #old',
    writeMarker(id, 'task-a'),
  ].join('\n\n'));
  assert.equal(taskA.items[0]!.iterationId, 'iter_0');
  assert.deepEqual(github.issues.map(issue => issue.title), ['Phase 2', 'MCP', 'Write issues', 'Old']);
  assert.equal(nodeOf(store, id, 'task-c').status, 'draft');
  assert.equal(nodeOf(store, id, 'task-c').draftNote, 'Not yet');
  assert.equal(store.getProposal(id)!.state, 'done');

  // The withheld item is approved later and lands under its already-created Feature.
  const code = issueApproveCode(store, id);
  assert.deepEqual(store.approveProposal(id, code), { ok: true });
  await writer.kick(id);
  assert.deepEqual(errors, []);
  assert.equal(github.issues.length, 5);
  assert.equal(github.byTitle('Later').parentId, github.byTitle('MCP').id);
  assert.equal(store.getProposal(id)!.state, 'done');
  assert.throws(() => issueApproveCode(store, id), /only pending proposals/);
});
