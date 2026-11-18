import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ciRollup,
  isAllowedHost,
  isLoopbackAddress,
  startMcpServer,
  taskSchemas,
  taskTools,
  type RunningMcpServer,
} from '../../src/mcp/server.ts';
import { Secret } from '../../src/secrets.ts';
import { openDb } from '../../src/store/db.ts';
import { Store, type IssueInput, type Pr } from '../../src/store/store.ts';

const TOKEN = 'test-mcp-token-0123456789';
const REPO = 'companie-apps/orchid-board';
const MIN = 60_000;
const TTL = 30 * MIN;

function issue(number: number, type: IssueInput['type'], parent: number | null, title = `issue ${number}`): IssueInput {
  return {
    ref: `${REPO}#${number}`,
    nodeId: `I_${number}`,
    type,
    title,
    state: 'open',
    parent: parent === null ? null : `${REPO}#${parent}`,
    iteration: type === 'Task' ? { id: 'it1', title: 'Sprint 1' } : null,
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

let clock = new Date('2026-11-18T00:00:00Z');
let store: Store;
let mcp: RunningMcpServer;

before(async () => {
  store = new Store(openDb(':memory:'), { now: () => clock });
  mcp = await startMcpServer({
    port: 0,
    token: new Secret('mcp.token', TOKEN),
    toolsets: [taskTools({ store, claimTtlMs: TTL })],
  });
});

after(async () => {
  await mcp.close();
  store.close();
});

beforeEach(() => {
  clock = new Date('2026-11-18T00:00:00Z');
  store.db.exec('DELETE FROM claims; DELETE FROM pr_issues; DELETE FROM checks; DELETE FROM prs; DELETE FROM issues;');
  store.upsertIssues([issue(1, 'Phase', null), issue(4, 'Feature', 1), issue(12, 'Task', 4), issue(13, 'Task', 4)]);
  store.upsertPr({
    ref: `${REPO}#30`,
    url: `https://github.com/${REPO}/pull/30`,
    title: 'mcp server',
    state: 'open',
    draft: false,
    issues: [`${REPO}#12`],
    updatedAt: '2026-11-18T00:00:00Z',
    checks: 'running',
  });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: content.map((c) => c.text).join('\n') };
  } finally {
    await client.close();
  }
}

function raw(options: { method?: string; headers?: Record<string, string>; path?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: mcp.port, path: options.path ?? '/mcp', method: options.method ?? 'POST', headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.method === 'GET' ? undefined : '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('tool schemas', () => {
  it('reject bad refs, empty agents, unknown keys and bad filters', () => {
    assert.equal(taskSchemas.claim.safeParse({ task: `${REPO}#12`, agent: 'claude' }).success, true);
    assert.equal(taskSchemas.claim.safeParse({ task: 'orchid-board#12', agent: 'claude' }).success, false);
    assert.equal(taskSchemas.claim.safeParse({ task: `${REPO}#0`, agent: 'claude' }).success, false);
    assert.equal(taskSchemas.claim.safeParse({ task: `${REPO}#12`, agent: '  ' }).success, false);
    assert.equal(taskSchemas.release.safeParse({ task: `${REPO}#12` }).success, false);
    assert.equal(taskSchemas.done.safeParse({ task: `${REPO}#12`, agent: 'a', extra: 1 }).success, false);
    assert.equal(taskSchemas.get_task.safeParse({ ref: 12 }).success, false);
    assert.equal(taskSchemas.list_tasks.safeParse({}).success, true);
    assert.equal(taskSchemas.list_tasks.safeParse({ status: 'claimed' }).success, false);
    assert.equal(taskSchemas.list_tasks.safeParse({ repo: 'not a repo' }).success, false);
  });

  it('reject bad input end to end', async () => {
    const result = await call('claim', { task: 'nope', agent: 'claude' });
    assert.equal(result.isError, true);
    assert.match(result.text, /owner\/name#number/);
  });
});

describe('http guards', () => {
  it('rejects a missing token', async () => {
    const res = await raw({ headers: { ...JSON_HEADERS, host: `127.0.0.1:${mcp.port}` } });
    assert.equal(res.status, 401);
  });

  it('rejects a wrong token without echoing it', async () => {
    const res = await raw({ headers: { ...JSON_HEADERS, host: `127.0.0.1:${mcp.port}`, authorization: 'Bearer wrong-token-value' } });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /wrong-token-value|test-mcp-token/);
  });

  it('rejects a non-loopback Host header', async () => {
    const res = await raw({ headers: { ...JSON_HEADERS, host: 'evil.example:80', authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 403);
    assert.equal(isAllowedHost(`localhost:${mcp.port}`, mcp.port), true);
    assert.equal(isAllowedHost(`127.0.0.1:${mcp.port + 1}`, mcp.port), false);
    assert.equal(isAllowedHost(undefined, mcp.port), false);
  });

  it('accepts only loopback remote addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.10'), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });

  it('allows only POST /mcp', async () => {
    const headers = { ...JSON_HEADERS, host: `localhost:${mcp.port}`, authorization: `Bearer ${TOKEN}` };
    assert.equal((await raw({ method: 'GET', headers })).status, 405);
    assert.equal((await raw({ path: '/other', headers })).status, 404);
  });
});

describe('task tools', () => {
  it('lists Tasks with filters', async () => {
    const all = JSON.parse((await call('list_tasks', {})).text) as Array<{ ref: string }>;
    assert.deepEqual(all.map((t) => t.ref), [`${REPO}#12`, `${REPO}#13`]);
    const sprint = JSON.parse((await call('list_tasks', { sprint: 'Sprint 2' })).text) as unknown[];
    assert.deepEqual(sprint, []);
    const closed = JSON.parse((await call('list_tasks', { repo: REPO, status: 'closed' })).text) as unknown[];
    assert.deepEqual(closed, []);
  });

  it('gets a task with parents, PRs, CI and claim', async () => {
    store.claim(`${REPO}#12`, 'claude', { ttlMs: TTL });
    const task = JSON.parse((await call('get_task', { ref: `${REPO}#12` })).text);
    assert.deepEqual(task.parents.map((p: { ref: string }) => p.ref), [`${REPO}#4`, `${REPO}#1`]);
    assert.equal(task.prs[0].ref, `${REPO}#30`);
    assert.equal(task.ci, 'running');
    assert.equal(task.claim.agent, 'claude');
    const feature = JSON.parse((await call('get_task', { ref: `${REPO}#4` })).text);
    assert.deepEqual(feature.children.map((c: { ref: string }) => c.ref), [`${REPO}#12`, `${REPO}#13`]);
    const missing = await call('get_task', { ref: `${REPO}#99` });
    assert.equal(missing.isError, true);
  });

  it('names the holder on a claim conflict', async () => {
    assert.equal((await call('claim', { task: `${REPO}#12`, agent: 'claude' })).isError, false);
    const conflict = await call('claim', { task: `${REPO}#12`, agent: 'codex' });
    assert.equal(conflict.isError, true);
    assert.match(conflict.text, /claimed by claude/);
    const release = await call('release', { task: `${REPO}#12`, agent: 'codex' });
    assert.equal(release.isError, true);
    assert.match(release.text, /claimed by claude/);
  });

  it('lets another agent claim after expiry', async () => {
    await call('claim', { task: `${REPO}#12`, agent: 'claude' });
    clock = new Date(clock.getTime() + TTL + MIN);
    const taken = await call('claim', { task: `${REPO}#12`, agent: 'codex' });
    assert.equal(taken.isError, false);
    assert.equal(store.getClaim(`${REPO}#12`)?.agent, 'codex');
  });

  it('release drops the claim', async () => {
    await call('claim', { task: `${REPO}#12`, agent: 'claude' });
    assert.equal((await call('release', { task: `${REPO}#12`, agent: 'claude' })).isError, false);
    assert.equal(store.getClaim(`${REPO}#12`), null);
    assert.equal((await call('release', { task: `${REPO}#12`, agent: 'claude' })).isError, true);
  });

  it('done releases the claim and records the signal', async () => {
    await call('claim', { task: `${REPO}#12`, agent: 'claude' });
    const done = await call('done', { task: `${REPO}#12`, agent: 'claude' });
    assert.equal(done.isError, false);
    assert.equal(store.getClaim(`${REPO}#12`), null);
    assert.deepEqual(store.getDone(`${REPO}#12`), { task: `${REPO}#12`, agent: 'claude', at: clock.toISOString() });
    const listed = JSON.parse((await call('list_tasks', {})).text) as Array<{ ref: string; done: unknown }>;
    assert.equal((listed.find((t) => t.ref === `${REPO}#12`)?.done as { agent: string }).agent, 'claude');
    // A later claim restarts work and clears the done signal.
    await call('claim', { task: `${REPO}#12`, agent: 'codex' });
    assert.equal(store.getDone(`${REPO}#12`), null);
  });

  it('done by a non-holder conflicts; non-Tasks are refused', async () => {
    await call('claim', { task: `${REPO}#12`, agent: 'claude' });
    const done = await call('done', { task: `${REPO}#12`, agent: 'codex' });
    assert.equal(done.isError, true);
    assert.match(done.text, /claimed by claude/);
    assert.equal(store.getDone(`${REPO}#12`), null);
    const feature = await call('claim', { task: `${REPO}#4`, agent: 'claude' });
    assert.equal(feature.isError, true);
    assert.match(feature.text, /Feature, not a Task/);
  });
});

describe('ciRollup', () => {
  const pr = (state: Pr['state'], checks: Pr['checks']): Pr =>
    ({ ref: `${REPO}#1`, repo: REPO, number: 1, url: '', title: '', state, draft: false, issues: [], updatedAt: '', checks });
  it('takes the worst state of open or merged PRs', () => {
    assert.equal(ciRollup([]), 'none');
    assert.equal(ciRollup([pr('merged', 'pass'), pr('open', 'fail')]), 'fail');
    assert.equal(ciRollup([pr('closed', 'fail'), pr('open', 'pass')]), 'pass');
  });
});
