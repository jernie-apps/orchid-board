import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubClient } from '../../src/github/client.ts';
import { listIssues } from '../../src/github/queries.ts';
import { Secret } from '../../src/secrets.ts';
import recorded from '../fixtures/github/recorded.json' with { type: 'json' };

const repo = { owner: 'companie-apps', name: 'orchid-board' };
const phasePage = recorded.issues.data.repository.issues;
const phase = phasePage.nodes[0]!;
const merged = recorded.pullRequest.data.repository.pullRequest;

function fakeClient(...pages: { operation: string; variables: object; response: unknown; selection: RegExp }[]) {
  const client = new GitHubClient(new Secret('github.token', 'fake-token'), {
    fetch: async (_url, init) => {
      const page = pages.shift();
      assert.ok(page, 'unexpected GraphQL request');
      const request = JSON.parse(String(init?.body));
      assert.match(request.query, new RegExp(`query ${page.operation}\\(`));
      assert.match(request.query, page.selection);
      assert.deepEqual(request.variables, page.variables);
      return Response.json(page.response);
    },
  });
  return { client, verify: () => assert.equal(pages.length, 0) };
}

function lastPage<T>(nodes: T[]) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
}

function firstPage<T>(nodes: T[], endCursor: string) {
  return { nodes, pageInfo: { hasNextPage: true, endCursor } };
}

function issuePage<T>(nodes: T[]) {
  return { data: { repository: { issues: lastPage(nodes) } } };
}

function connectionPage<T>(nodes: T[]) {
  return { data: { node: { connection: lastPage(nodes) } } };
}

function pr(number: number, state: string, isDraft: boolean, check: string | null) {
  return {
    number, url: `https://github.com/companie-apps/orchid-board/pull/${number}`, state, isDraft,
    commits: { nodes: [{ commit: { statusCheckRollup: check === null ? null : { state: check } } }] },
  };
}

test('lists updated issues with hierarchy, configured iteration, and all linked PR states across pages', async () => {
  const since = phase.updatedAt;
  const task = {
    ...phase,
    id: 'task-node',
    title: 'A closed task',
    state: 'CLOSED',
    number: 8,
    issueType: { name: 'Task' },
    parent: { number: 21, repository: { nameWithOwner: 'another-org/another-repo' } },
    subIssues: lastPage([]),
    projectItems: firstPage([
      { project: { number: 12, owner: { login: 'other-org' } }, fieldValueByName: { title: 'Wrong', iterationId: 'wrong' } },
    ], 'projects-2'),
    closedByPullRequestsReferences: firstPage([merged], 'pulls-2'),
  };
  const issueVariables = { owner: repo.owner, name: repo.name, since, withProject: true };
  const issueSelection = /filterBy: \{ since: \$since \}/;
  const { client, verify } = fakeClient(
    {
      operation: 'RepoIssues', variables: { ...issueVariables, cursor: null },
      response: recorded.issues, selection: issueSelection,
    },
    {
      operation: 'IssueSubIssues', variables: { id: phase.id, cursor: phase.subIssues.pageInfo.endCursor },
      response: recorded.subIssues, selection: /subIssues\(first: 100, after: \$cursor\)/,
    },
    {
      operation: 'RepoIssues', variables: { ...issueVariables, cursor: phasePage.pageInfo.endCursor },
      response: issuePage([task]), selection: issueSelection,
    },
    {
      operation: 'IssueClosingPullRequests', variables: { id: task.id, cursor: 'pulls-2' },
      response: connectionPage([
        pr(17, 'OPEN', true, 'PENDING'), pr(18, 'CLOSED', false, 'FAILURE'), pr(19, 'OPEN', false, null),
        pr(20, 'OPEN', false, 'EXPECTED'), pr(21, 'OPEN', false, 'ERROR'),
      ]),
      selection: /includeClosedPrs: true/,
    },
    {
      operation: 'IssueProjectItems', variables: { id: task.id, cursor: 'projects-2' },
      response: connectionPage([
        { project: { number: 14, owner: { login: 'companie-apps' } }, fieldValueByName: { title: 'Wrong', iterationId: 'wrong' } },
        { project: { number: 12, owner: { login: 'companie-apps' } }, fieldValueByName: { title: 'Sprint 2', iterationId: 'iteration-2' } },
      ]),
      selection: /fieldValueByName\(name: "Iteration"\)/,
    },
  );
  const issues = await listIssues(client, repo, { since, project: { owner: 'COMPANIE-APPS', number: 12 } });
  verify();
  assert.deepEqual(issues, [
    {
      ref: 'companie-apps/orchid-board#1', number: 1, nodeId: phase.id, title: phase.title,
      state: 'open', updatedAt: since, issueType: 'Phase', parentRef: null,
      subIssueRefs: [2, 3, 4, 5].map(number => `companie-apps/orchid-board#${number}`),
      iteration: null, pullRequests: [],
    },
    {
      ref: 'companie-apps/orchid-board#8', number: 8, nodeId: 'task-node', title: 'A closed task',
      state: 'closed', updatedAt: since, issueType: 'Task', parentRef: 'another-org/another-repo#21',
      subIssueRefs: [], iteration: { title: 'Sprint 2', iterationId: 'iteration-2' },
      pullRequests: [
        { number: 16, url: merged.url, state: 'merged', draft: false, checkStatus: 'pass' },
        { number: 17, url: 'https://github.com/companie-apps/orchid-board/pull/17', state: 'open', draft: true, checkStatus: 'running' },
        { number: 18, url: 'https://github.com/companie-apps/orchid-board/pull/18', state: 'closed', draft: false, checkStatus: 'fail' },
        { number: 19, url: 'https://github.com/companie-apps/orchid-board/pull/19', state: 'open', draft: false, checkStatus: 'none' },
        { number: 20, url: 'https://github.com/companie-apps/orchid-board/pull/20', state: 'open', draft: false, checkStatus: 'running' },
        { number: 21, url: 'https://github.com/companie-apps/orchid-board/pull/21', state: 'open', draft: false, checkStatus: 'fail' },
      ],
    },
  ]);
});

test('full reads retain untyped issues and skip project items when no project is configured', async () => {
  const issue = { ...phase, projectItems: undefined, subIssues: lastPage([]) };
  const { client, verify } = fakeClient({
    operation: 'RepoIssues',
    variables: { owner: repo.owner, name: repo.name, since: null, cursor: null, withProject: false },
    response: issuePage([
      { ...issue, issueType: { name: 'Bug' } }, { ...issue, number: 2, issueType: null },
    ]),
    selection: /@include\(if: \$withProject\)/,
  });
  const issues = await listIssues(client, repo);
  verify();
  assert.deepEqual(issues.map(issue => [issue.number, issue.issueType, issue.iteration]), [[1, null, null], [2, null, null]]);
});
