import type { ProjectRef, RepoRef } from '../config.ts';
import { GitHubError, paginate } from './client.ts';
import type { GitHubClient, GitHubPage } from './client.ts';
import type { CheckStatus, Issue, IssueRef, IssueType, Iteration, PullRequest, RepoPullRequest } from './types.ts';

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const ISSUE_REF = 'number repository { nameWithOwner }';
const PROJECT_ITEM = `
  project { number owner { ... on Organization { login } ... on User { login } } }
  fieldValueByName(name: "Iteration") {
    ... on ProjectV2ItemFieldIterationValue { title iterationId }
  }
`;
const PULL_REQUEST = `
  number url title updatedAt state isDraft
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;
const CLOSING_PRS = 'closedByPullRequestsReferences';
const REPO_PULL_REQUESTS = `
  query RepoPullRequests($owner: String!, $name: String!, $cursor: String,
                         $states: [PullRequestState!], $direction: OrderDirection!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      pullRequests(first: 50, after: $cursor, states: $states,
                   orderBy: { field: UPDATED_AT, direction: $direction }) {
        ${PAGE_INFO}
        nodes {
          id body baseRefName
          ${PULL_REQUEST}
          closingIssuesReferences(first: 10) { ${PAGE_INFO} nodes { ${ISSUE_REF} } }
        }
      }
    }
  }
`;
const PR_CLOSING_ISSUES = nodePageQuery('PullRequestClosingIssues', 'PullRequest', 'closingIssuesReferences(first: 50, after: $cursor)', ISSUE_REF);

const REPO_ISSUES = `
  query RepoIssues($owner: String!, $name: String!, $since: DateTime, $cursor: String, $withProject: Boolean!) {
    repository(owner: $owner, name: $name) {
      issues(first: 50, after: $cursor, filterBy: { since: $since },
             orderBy: { field: UPDATED_AT, direction: ASC }) {
        ${PAGE_INFO}
        nodes {
          id title state updatedAt issueType { name }
          ${ISSUE_REF}
          parent { ${ISSUE_REF} }
          subIssues(first: 10) { ${PAGE_INFO} nodes { ${ISSUE_REF} } }
          projectItems(first: 10, includeArchived: true) @include(if: $withProject) {
            ${PAGE_INFO} nodes { ${PROJECT_ITEM} }
          }
          ${CLOSING_PRS}(first: 10, includeClosedPrs: true) {
            ${PAGE_INFO} nodes { ${PULL_REQUEST} }
          }
        }
      }
    }
  }
`;

const SUB_ISSUES = nodePageQuery('IssueSubIssues', 'Issue', 'subIssues(first: 100, after: $cursor)', ISSUE_REF);
const PROJECT_ITEMS = nodePageQuery('IssueProjectItems', 'Issue', 'projectItems(first: 100, after: $cursor, includeArchived: true)', PROJECT_ITEM);
const PULL_REQUESTS = nodePageQuery('IssueClosingPullRequests', 'Issue', `${CLOSING_PRS}(first: 50, after: $cursor, includeClosedPrs: true)`, PULL_REQUEST);
const ISSUE_PULL_REQUESTS = `
  query IssuesWithPullRequests($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        ${CLOSING_PRS}(first: 10, includeClosedPrs: true) { ${PAGE_INFO} nodes { ${PULL_REQUEST} } }
      }
    }
  }
`;
const ISSUE_ID_BATCH_SIZE = 50;

interface ApiIssueRef {
  number: number;
  repository: { nameWithOwner: `${string}/${string}` };
}

interface ApiIssuePullRequests {
  id: string;
  closedByPullRequestsReferences: GitHubPage<ApiPullRequest>;
}

interface ApiIssue extends ApiIssueRef, ApiIssuePullRequests {
  title: string;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  issueType: { name: string } | null;
  parent: ApiIssueRef | null;
  subIssues: GitHubPage<ApiIssueRef>;
  projectItems?: GitHubPage<ApiProjectItem>;
}

interface ApiProjectItem {
  project: { number: number; owner: { login?: string } };
  fieldValueByName: Partial<Iteration> | null;
}

interface ApiPullRequest {
  number: number;
  url: string;
  title: string;
  updatedAt: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] | null };
}

interface ApiRepoPullRequest extends ApiPullRequest {
  id: string;
  body: string;
  baseRefName: string;
  closingIssuesReferences: GitHubPage<ApiIssueRef>;
}

type QueryClient = Pick<GitHubClient, 'graphql'>;

/** GitHub has no PR `since` filter. Stop at the updatedAt boundary in each sorted stream. */
export async function listRepoPullRequests(client: QueryClient, repo: RepoRef, since: string | null): Promise<RepoPullRequest[]> {
  const cutoff = since === null ? null : Date.parse(since);
  const result: RepoPullRequest[] = [];

  // Checks can change without bumping updatedAt, so also fetch older open PRs.
  if (cutoff !== null) {
    for await (const { pr, repoName } of repoPullRequests(client, repo, ['OPEN'], 'ASC')) {
      if (Date.parse(pr.updatedAt) >= cutoff) break;
      result.push(await repoPullRequest(client, pr, repoName));
    }
  }
  for await (const { pr, repoName } of repoPullRequests(client, repo, null, 'DESC')) {
    if (cutoff !== null && Date.parse(pr.updatedAt) < cutoff) break;
    result.push(await repoPullRequest(client, pr, repoName));
  }
  return result;
}

function repoPullRequests(
  client: QueryClient, repo: RepoRef, states: ['OPEN'] | null, direction: 'ASC' | 'DESC',
): AsyncGenerator<{ pr: ApiRepoPullRequest; repoName: `${string}/${string}` }> {
  return paginate(async cursor => {
    const { repository } = await client.graphql<{
      repository: { nameWithOwner: `${string}/${string}`; pullRequests: GitHubPage<ApiRepoPullRequest> } | null;
    }>(REPO_PULL_REQUESTS, { owner: repo.owner, name: repo.name, cursor, states, direction });
    if (!repository) throw new GitHubError('GitHub repository was not found');
    const { nameWithOwner: repoName, pullRequests } = repository;
    return { ...pullRequests, nodes: pullRequests.nodes?.map(pr => pr && { pr, repoName }) ?? null };
  });
}

async function repoPullRequest(client: QueryClient, pr: ApiRepoPullRequest, repo: `${string}/${string}`): Promise<RepoPullRequest> {
  const githubIssueRefs: IssueRef[] = [];
  for await (const issue of nodePages(client, pr.id, PR_CLOSING_ISSUES, pr.closingIssuesReferences)) {
    githubIssueRefs.push(issueRef(issue));
  }
  return { ...pullRequest(pr), baseRefName: pr.baseRefName, bodyIssueRefs: closingKeywords(pr.body, repo), githubIssueRefs };
}

function closingKeywords(body: string, repo: `${string}/${string}`): IssueRef[] {
  const refs = new Set<IssueRef>();
  const keywords = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(?:\s*:\s*|\s+)(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*)(?![\w/])/gi;
  for (const [, target, digits] of body.matchAll(keywords)) {
    const number = Number(digits);
    if (Number.isSafeInteger(number)) refs.add(`${(target ?? repo).toLowerCase()}#${number}` as IssueRef);
  }
  return [...refs];
}

/** List open and closed issues. GitHub treats `since` as an inclusive updatedAt bound. */
export async function listIssues(
  client: QueryClient,
  repo: RepoRef,
  { since = null, project = null }: { since?: string | null; project?: ProjectRef | null } = {},
): Promise<Issue[]> {
  const pages = paginate(async cursor => {
    const { repository } = await client.graphql<{ repository: { issues: GitHubPage<ApiIssue> } | null }>(
      REPO_ISSUES, { owner: repo.owner, name: repo.name, since, cursor, withProject: project !== null },
    );
    if (!repository) throw new GitHubError('GitHub repository was not found');
    return repository.issues;
  });

  const issues: Issue[] = [];
  for await (const issue of pages) {
    const subIssueRefs: IssueRef[] = [];
    for await (const subIssue of nodePages(client, issue.id, SUB_ISSUES, issue.subIssues)) {
      subIssueRefs.push(issueRef(subIssue));
    }
    const pullRequests = await closingPullRequests(client, issue);
    issues.push({
      ref: issueRef(issue),
      number: issue.number,
      nodeId: issue.id,
      title: issue.title,
      state: issue.state === 'OPEN' ? 'open' : 'closed',
      updatedAt: issue.updatedAt,
      issueType: issueType(issue.issueType?.name),
      parentRef: issue.parent ? issueRef(issue.parent) : null,
      subIssueRefs,
      iteration: project ? await findIteration(client, issue, project) : null,
      pullRequests,
    });
  }
  return issues;
}

/** Refresh PR links and checks even when the issues themselves have not changed. */
export async function listIssuePullRequests(
  client: QueryClient,
  nodeIds: readonly string[],
): Promise<Map<string, PullRequest[]>> {
  const result = new Map<string, PullRequest[]>();
  for (let offset = 0; offset < nodeIds.length; offset += ISSUE_ID_BATCH_SIZE) {
    const ids = nodeIds.slice(offset, offset + ISSUE_ID_BATCH_SIZE);
    const { nodes } = await client.graphql<{ nodes: (ApiIssuePullRequests | null)[] }>(
      ISSUE_PULL_REQUESTS, { ids }, { allowMissingNodes: true },
    );
    for (const node of nodes) {
      if (node?.id) result.set(node.id, await closingPullRequests(client, node));
    }
  }
  return result;
}

async function closingPullRequests(client: QueryClient, issue: ApiIssuePullRequests): Promise<PullRequest[]> {
  const result: PullRequest[] = [];
  for await (const pr of nodePages(client, issue.id, PULL_REQUESTS, issue.closedByPullRequestsReferences)) {
    result.push(pullRequest(pr));
  }
  return result;
}

function nodePageQuery(operation: string, type: 'Issue' | 'PullRequest', connection: string, selection: string): string {
  return `query ${operation}($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on ${type} {
        connection: ${connection} { ${PAGE_INFO} nodes { ${selection} } }
      }
    }
  }`;
}

function nodePages<T>(client: QueryClient, id: string, query: string, firstPage: GitHubPage<T>): AsyncGenerator<T> {
  return paginate(async cursor => {
    const { node } = await client.graphql<{ node: { connection?: GitHubPage<T> } | null }>(query, { id, cursor });
    if (!node?.connection) throw new GitHubError('GitHub node was not found while paging its connections');
    return node.connection;
  }, firstPage);
}

async function findIteration(client: QueryClient, issue: ApiIssue, project: ProjectRef): Promise<Iteration | null> {
  if (!issue.projectItems) throw new GitHubError('GitHub issue response did not contain project items');
  const owner = project.owner.toLowerCase();
  for await (const item of nodePages(client, issue.id, PROJECT_ITEMS, issue.projectItems)) {
    if (item.project.number === project.number && item.project.owner.login?.toLowerCase() === owner) {
      const value = item.fieldValueByName;
      return typeof value?.title === 'string' && typeof value.iterationId === 'string'
        ? { title: value.title, iterationId: value.iterationId }
        : null;
    }
  }
  return null;
}

function issueRef(issue: ApiIssueRef): IssueRef {
  return `${issue.repository.nameWithOwner}#${issue.number}`;
}

function issueType(name: string | undefined): IssueType | null {
  return name === 'Phase' || name === 'Feature' || name === 'Task' ? name : null;
}

function pullRequest(pr: ApiPullRequest): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    updatedAt: pr.updatedAt,
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    draft: pr.isDraft,
    checkStatus: checkStatus(pr.commits.nodes?.[0]?.commit.statusCheckRollup?.state),
  };
}

function checkStatus(state: string | undefined): CheckStatus {
  switch (state) {
    case 'SUCCESS': return 'pass';
    case 'FAILURE':
    case 'ERROR': return 'fail';
    case 'EXPECTED':
    case 'PENDING': return 'running';
    default: return 'none';
  }
}
