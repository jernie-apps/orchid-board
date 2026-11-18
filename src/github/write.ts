import type { ProjectRef, RepoRef } from '../config.ts';
import { GitHubError } from './client.ts';
import type { GitHubClient } from './client.ts';

// GitHub writes for approved proposals. Every mutation runs with retryServerErrors: false,
// because a 5xx can mean the write already happened; callers check before they act instead.

export type WriteClient = Pick<GitHubClient, 'graphql'>;

const MUTATION = { retryServerErrors: false } as const;

export interface WriteRepo {
  id: string;
  /** Issue type IDs by name, from the owning organization. Null when the owner is not an organization. */
  issueTypes: ReadonlyMap<string, string> | null;
}

export interface CreatedIssue {
  id: string;
  number: number;
}

export interface WriteIssueState extends CreatedIssue {
  issueTypeId: string | null;
  parentId: string | null;
  projectItems: { id: string; projectId: string; iterationId: string | null }[];
}

export interface WriteProject {
  id: string;
  /** The `Iteration` field, or null when the project has none. */
  iterationField: { id: string; iterations: { id: string; title: string }[] } | null;
}

const REPO = `
  query WriteRepo($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      owner { ... on Organization { issueTypes(first: 50) { nodes { id name } } } }
    }
  }`;

export async function getWriteRepo(client: WriteClient, repo: RepoRef): Promise<WriteRepo> {
  const data = await client.graphql<{
    repository: { id: string; owner: { issueTypes?: { nodes: ({ id: string; name: string } | null)[] | null } } } | null;
  }>(REPO, { owner: repo.owner, name: repo.name });
  if (!data.repository) throw new GitHubError(`GitHub repository ${repo.owner}/${repo.name} was not found`);
  const types = data.repository.owner.issueTypes;
  return {
    id: data.repository.id,
    issueTypes: types ? new Map((types.nodes ?? []).flatMap(type => type ? [[type.name, type.id] as const] : [])) : null,
  };
}

export async function getViewerLogin(client: WriteClient): Promise<string> {
  const data = await client.graphql<{ viewer: { login: string } }>('query WriteViewer { viewer { login } }');
  return data.viewer.login;
}

const FIND_BY_MARKER = `
  query WriteFindMarker($owner: String!, $name: String!, $login: String!) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: { createdBy: $login }) {
        nodes { id number body }
      }
    }
  }`;

/** The newest issue created by `login` whose body contains `marker`. Reads the issue list, not the lagging search index. */
export async function findIssueByMarker(
  client: WriteClient, repo: RepoRef, login: string, marker: string,
): Promise<CreatedIssue | null> {
  const data = await client.graphql<{
    repository: { issues: { nodes: ({ id: string; number: number; body: string } | null)[] | null } } | null;
  }>(FIND_BY_MARKER, { owner: repo.owner, name: repo.name, login });
  const found = data.repository?.issues.nodes?.find(issue => issue?.body.includes(marker));
  return found ? { id: found.id, number: found.number } : null;
}

const CREATE_ISSUE = `
  mutation WriteCreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) { issue { id number } }
  }`;

export async function createIssue(
  client: WriteClient,
  input: { repositoryId: string; title: string; body: string; issueTypeId: string },
): Promise<CreatedIssue> {
  const data = await client.graphql<{ createIssue: { issue: CreatedIssue | null } | null }>(CREATE_ISSUE, { input }, MUTATION);
  const issue = data.createIssue?.issue;
  if (!issue) throw new GitHubError('GitHub createIssue returned no issue');
  return issue;
}

const ISSUE_ID = `
  query WriteIssueId($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { id } }
  }`;

export async function getIssueId(client: WriteClient, repo: RepoRef, number: number): Promise<string> {
  const data = await client.graphql<{ repository: { issue: { id: string } | null } | null }>(
    ISSUE_ID, { owner: repo.owner, name: repo.name, number },
  );
  const id = data.repository?.issue?.id;
  if (!id) throw new GitHubError(`GitHub issue ${repo.owner}/${repo.name}#${number} was not found`);
  return id;
}

const ISSUE_STATE = `
  query WriteIssueState($id: ID!) {
    node(id: $id) {
      ... on Issue {
        id number
        issueType { id }
        parent { id }
        projectItems(first: 50) {
          nodes {
            id
            project { id }
            fieldValueByName(name: "Iteration") { ... on ProjectV2ItemFieldIterationValue { iterationId } }
          }
        }
      }
    }
  }`;

export async function getIssueState(client: WriteClient, id: string): Promise<WriteIssueState> {
  const data = await client.graphql<{
    node: {
      id?: string;
      number?: number;
      issueType: { id: string } | null;
      parent: { id: string } | null;
      projectItems: {
        nodes: ({ id: string; project: { id: string }; fieldValueByName: { iterationId?: string } | null } | null)[] | null;
      };
    } | null;
  }>(ISSUE_STATE, { id });
  const node = data.node;
  if (!node?.id || node.number === undefined) throw new GitHubError('GitHub issue was not found');
  return {
    id: node.id,
    number: node.number,
    issueTypeId: node.issueType?.id ?? null,
    parentId: node.parent?.id ?? null,
    projectItems: (node.projectItems.nodes ?? []).flatMap(item => item ? [{
      id: item.id,
      projectId: item.project.id,
      iterationId: item.fieldValueByName?.iterationId ?? null,
    }] : []),
  };
}

const SET_ISSUE_TYPE = `
  mutation WriteSetIssueType($id: ID!, $issueTypeId: ID!) {
    updateIssue(input: { id: $id, issueTypeId: $issueTypeId }) { issue { id } }
  }`;

export async function setIssueType(client: WriteClient, id: string, issueTypeId: string): Promise<void> {
  await client.graphql(SET_ISSUE_TYPE, { id, issueTypeId }, MUTATION);
}

const ADD_SUB_ISSUE = `
  mutation WriteAddSubIssue($parentId: ID!, $childId: ID!) {
    addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { id } }
  }`;

export async function addSubIssue(client: WriteClient, parentId: string, childId: string): Promise<void> {
  await client.graphql(ADD_SUB_ISSUE, { parentId, childId }, MUTATION);
}

const PROJECT = `
  query WriteProject($owner: String!, $number: Int!) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          field(name: "Iteration") {
            ... on ProjectV2IterationField {
              id
              configuration { iterations { id title } completedIterations { id title } }
            }
          }
        }
      }
    }
  }`;

export async function getProject(client: WriteClient, project: ProjectRef): Promise<WriteProject> {
  type Iterations = { id: string; title: string }[];
  const data = await client.graphql<{
    repositoryOwner: {
      projectV2?: {
        id: string;
        field: { id?: string; configuration?: { iterations: Iterations; completedIterations: Iterations } } | null;
      } | null;
    } | null;
  }>(PROJECT, { owner: project.owner, number: project.number });
  const found = data.repositoryOwner?.projectV2;
  if (!found) throw new GitHubError(`GitHub project ${project.owner}#${project.number} was not found`);
  const field = found.field;
  return {
    id: found.id,
    iterationField: field?.id && field.configuration
      ? { id: field.id, iterations: [...field.configuration.iterations, ...field.configuration.completedIterations] }
      : null,
  };
}

const ADD_PROJECT_ITEM = `
  mutation WriteAddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }`;

export async function addProjectItem(client: WriteClient, projectId: string, contentId: string): Promise<string> {
  const data = await client.graphql<{ addProjectV2ItemById: { item: { id: string } | null } | null }>(
    ADD_PROJECT_ITEM, { projectId, contentId }, MUTATION,
  );
  const id = data.addProjectV2ItemById?.item?.id;
  if (!id) throw new GitHubError('GitHub addProjectV2ItemById returned no item');
  return id;
}

const SET_ITERATION = `
  mutation WriteSetIteration($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { iterationId: $iterationId }
    }) { projectV2Item { id } }
  }`;

export async function setIteration(
  client: WriteClient, input: { projectId: string; itemId: string; fieldId: string; iterationId: string },
): Promise<void> {
  await client.graphql(SET_ITERATION, input, MUTATION);
}
