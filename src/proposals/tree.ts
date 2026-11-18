import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { StoreError, type IssueType, type Proposal, type ProposalNode, type ProposalNodeInput, type Store } from '../store/store.ts';

export interface DraftNode {
  key?: string | undefined;
  type: IssueType;
  repo: string;
  title: string;
  body?: string | undefined;
  iteration?: string | null | undefined;
  children?: DraftNode[] | undefined;
}

export interface ProposalDeps {
  store: Store;
  repos: Config['repos'];
}

type Parent = Pick<ProposalNode, 'type' | 'branch' | 'title'> & { key: string | null };

const NEXT_TYPE = { Phase: 'Feature', Feature: 'Task', Task: null } as const;
const SLUG_LENGTH = 40;

export function proposeTree(
  deps: ProposalDeps,
  input: { agent: string; parent?: string | null | undefined; nodes: readonly DraftNode[] },
): Proposal {
  const { store } = deps;
  const parent = input.parent ?? null;
  return store.transaction(() => {
    const flatten = prepareDrafts(deps, parent, []);
    return store.createProposal({ agent: input.agent, parent, nodes: flatten(input.nodes) });
  });
}

export function resubmitTree(deps: ProposalDeps, id: string, nodes: readonly DraftNode[]): Proposal {
  const byRoot = new Map<string, DraftNode>();
  for (const node of nodes) {
    if (!node.key) throw new StoreError('each replacement root needs its sent-back node key');
    if (byRoot.has(node.key)) throw new StoreError('duplicate replacement root key');
    byRoot.set(node.key, node);
  }
  return deps.store.resubmitSubtrees(id, new Set(byRoot.keys()), (proposal, retained) => {
    const flatten = prepareDrafts(deps, proposal.parent, retained);
    const parents = new Map(retained.map(node => [node.key, node]));
    const replacements = new Map<string, ProposalNodeInput[]>();
    for (const root of proposal.nodes) {
      const node = byRoot.get(root.key);
      if (!node) continue;
      const parent = root.parentKey === null ? undefined : parents.get(root.parentKey)!;
      replacements.set(root.key, flatten([node], parent));
    }
    return replacements;
  });
}

function prepareDrafts(deps: ProposalDeps, parentRef: string | null, retained: readonly ProposalNode[]) {
  const repos = new Map(deps.repos.map(({ owner, name }) => {
    const repo = owner + '/' + name;
    return [repo.toLowerCase(), repo];
  }));
  const keys = new Set(retained.map(node => node.key));
  const branches = new Set(retained.flatMap(node => node.branch === null ? [] : [node.branch]));
  const externalParent = cachedParent(deps.store, parentRef, branches);

  return (nodes: readonly DraftNode[], parent: Parent | null = externalParent): ProposalNodeInput[] => {
    const flat: ProposalNodeInput[] = [];
    const visit = (node: DraftNode, parent: Parent | null): void => {
      const expected = parent === null ? 'Phase' : NEXT_TYPE[parent.type];
      if (expected === null) throw new StoreError('a Task cannot have child nodes');
      if (node.type !== expected) {
        throw new StoreError('expected a ' + expected + ' node, got ' + node.type);
      }
      const title = node.title.trim();
      if (!title) throw new StoreError('node title must be non-empty');
      const repo = repos.get(node.repo.toLowerCase());
      if (!repo) throw new StoreError('repository "' + node.repo + '" is outside config.repos');
      const key = node.key ?? randomUUID();
      if (keys.has(key)) throw new StoreError('duplicate node key "' + key + '"');
      keys.add(key);
      const branch = branchFor(node.type, title, parent, branches);
      flat.push({ key, parentKey: parent?.key ?? null, repo, type: node.type, title, body: node.body, iteration: node.iteration, branch });
      for (const child of node.children ?? []) visit(child, { key, type: node.type, title, branch });
    };
    for (const node of nodes) visit(node, parent);
    return flat;
  };
}

function cachedParent(store: Store, ref: string | null, branches: Set<string>): Parent | null {
  if (ref === null) return null;
  const issue = store.getIssue(ref);
  if (!issue) throw new StoreError('parent issue is missing from the board cache');
  if (issue.type === null) throw new StoreError('cached parent issue has no issue type');
  if (issue.type === 'Task') throw new StoreError('a Task cannot have child nodes');
  const parent = {
    key: null,
    type: issue.type,
    title: issue.title,
    branch: store.getCreatedIssueBranch(issue.nodeId),
  };
  // Keep branches recorded for cached siblings. Allocate title-based names for older issues.
  const siblings = store.listIssues().filter(child => child.parent === ref && child.type === NEXT_TYPE[parent.type]);
  const withoutBranches = [];
  for (const sibling of siblings) {
    const branch = store.getCreatedIssueBranch(sibling.nodeId);
    if (branch === null) withoutBranches.push(sibling);
    else branches.add(branch);
  }
  for (const sibling of withoutBranches) branchFor(NEXT_TYPE[parent.type], sibling.title, parent, branches);
  return parent;
}

function branchFor(type: IssueType, title: string, parent: Parent | null, used: Set<string>): string | null {
  if (type === 'Phase') return null;
  if (type === 'Feature') return allocateBranch(title, 'feature', slug => 'feature/' + slug + '/' + slug, used);
  const feature = featureSlug(parent!);
  // The Feature's own branch already takes this Task slug in the same namespace.
  used.add('feature/' + feature + '/' + feature);
  return allocateBranch(title, 'task', slug => 'feature/' + feature + '/' + slug, used);
}

function featureSlug(parent: Parent): string {
  const recorded = parent.branch?.match(/^feature\/([a-z0-9-]+)\/\1$/)?.[1];
  return recorded ?? slugify(parent.title, 'feature');
}

function slugify(title: string, fallback: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_LENGTH).replace(/-+$/, '') || fallback;
}

function allocateBranch(title: string, fallback: string, path: (slug: string) => string, used: Set<string>): string {
  const base = slugify(title, fallback);
  let branch = path(base);
  for (let collision = 2; used.has(branch); collision++) {
    const suffix = '-' + collision;
    branch = path(base.slice(0, SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix);
  }
  used.add(branch);
  return branch;
}
