import type { ProjectRef, RepoRef } from '../config.ts';
import { GitHubError, paginate } from './client.ts';
import type { GitHubClient, GitHubPage } from './client.ts';
import type { CheckStatus, Issue, IssueRef, IssueType, Iteration, PullRequest } from './types.ts';

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const ISSUE_REF = 'number repository { nameWithOwner }';
const PROJECT_ITEM = `
  project { number owner { ... on Organization { login } ... on User { login } } }
  fieldValueByName(name: "Iteration") {
    ... on ProjectV2ItemFieldIterationValue { title iterationId }
  }
`;
const PULL_REQUEST = `
  number url state isDraft
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

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
          closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
            ${PAGE_INFO} nodes { ${PULL_REQUEST} }
          }
        }
      }
    }
  }
`;

const SUB_ISSUES = issuePageQuery('IssueSubIssues', 'subIssues(first: 100, after: $cursor)', ISSUE_REF);
const PROJECT_ITEMS = issuePageQuery('IssueProjectItems', 'projectItems(first: 100, after: $cursor, includeArchived: true)', PROJECT_ITEM);
const PULL_REQUESTS = issuePageQuery('IssueClosingPullRequests', 'closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: true)', PULL_REQUEST);

interface ApiIssueRef {
  number: number;
  repository: { nameWithOwner: `${string}/${string}` };
}

interface ApiIssue extends ApiIssueRef {
  id: string;
  title: string;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  issueType: { name: string } | null;
  parent: ApiIssueRef | null;
  subIssues: GitHubPage<ApiIssueRef>;
  projectItems?: GitHubPage<ApiProjectItem>;
  closedByPullRequestsReferences: GitHubPage<ApiPullRequest>;
}

interface ApiProjectItem {
  project: { number: number; owner: { login?: string } };
  fieldValueByName: Partial<Iteration> | null;
}

interface ApiPullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] | null };
}

type QueryClient = Pick<GitHubClient, 'graphql'>;

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
    for await (const subIssue of issuePages(client, issue.id, SUB_ISSUES, issue.subIssues)) {
      subIssueRefs.push(issueRef(subIssue));
    }
    const pullRequests: PullRequest[] = [];
    for await (const pr of issuePages(client, issue.id, PULL_REQUESTS, issue.closedByPullRequestsReferences)) {
      pullRequests.push(pullRequest(pr));
    }
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

function issuePageQuery(operation: string, connection: string, selection: string): string {
  return `query ${operation}($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on Issue {
        connection: ${connection} { ${PAGE_INFO} nodes { ${selection} } }
      }
    }
  }`;
}

function issuePages<T>(client: QueryClient, id: string, query: string, firstPage: GitHubPage<T>): AsyncGenerator<T> {
  return paginate(async cursor => {
    const { node } = await client.graphql<{ node: { connection?: GitHubPage<T> } | null }>(query, { id, cursor });
    if (!node?.connection) throw new GitHubError('GitHub issue was not found while paging its connections');
    return node.connection;
  }, firstPage);
}

async function findIteration(client: QueryClient, issue: ApiIssue, project: ProjectRef): Promise<Iteration | null> {
  if (!issue.projectItems) throw new GitHubError('GitHub issue response did not contain project items');
  const owner = project.owner.toLowerCase();
  for await (const item of issuePages(client, issue.id, PROJECT_ITEMS, issue.projectItems)) {
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
