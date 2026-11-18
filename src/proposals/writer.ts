import type { ProjectRef, RepoRef } from '../config.ts';
import {
  addProjectItem, addSubIssue, createIssue, findIssueByMarker, getIssueId, getIssueState, getProject, getViewerLogin,
  getWriteRepo, setIssueType, setIteration,
  type CreatedIssue, type WriteClient, type WriteProject, type WriteRepo,
} from '../github/write.ts';
import { redact, type Secret } from '../secrets.ts';
import { parseRef } from '../store/ref.ts';
import type { Proposal, ProposalNode, Store } from '../store/store.ts';

// Creates approved proposal trees in GitHub. Maps store <-> github, so neither imports the other.
//
// Resume model: each created issue is recorded on its node right after createIssue returns, and
// every later step (issue type, sub-issue link, project item, iteration) checks GitHub before it acts.
// Before the first createIssue for a node the node key is persisted as an "attempt"; a node with an
// attempt but no recorded number may have been created just before a crash or a 5xx, so the writer
// first looks for an issue carrying the node's hidden body marker and adopts it.

export interface WriteStatus {
  running: boolean;
  /** Last failure, redacted. Cleared by the next successful run. */
  error: string | null;
  /** Non-fatal skips from the last run, e.g. an iteration missing from the project. */
  warnings: string[];
  failures: number;
  /** When the writer will retry after a failure. */
  retryAt: string | null;
  updatedAt: string | null;
}

interface StoredStatus extends Omit<WriteStatus, 'running'> {
  /** Node keys whose createIssue was sent at least once. */
  attempts: string[];
}

export interface ProposalWriterOptions {
  store: Store;
  client: WriteClient;
  project: ProjectRef | null;
  /** Redacted from every surfaced error. */
  secrets?: readonly Secret[];
  /** Called with the `owner/name` repos a run wrote to, so sync can pick up the new issues. */
  onWritten?: (repos: string[]) => unknown;
  onError?: (proposalId: string, message: string) => void;
  /** Delay before retry number `failures`. Default: 1 min doubling up to 30 min. */
  retryDelayMs?: (failures: number) => number;
  now?: () => Date;
}

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export function writeMarker(proposalId: string, key: string): string {
  return `<!-- orchid:proposal=${encodeURIComponent(proposalId)} node=${encodeURIComponent(key)} -->`;
}

export function issueBody(node: Pick<ProposalNode, 'body' | 'branch'>, marker: string): string {
  const parts = [];
  if (node.body.trim() !== '') parts.push(node.body.trim());
  if (node.branch !== null) parts.push('Branch: `' + node.branch + '`');
  parts.push(marker);
  return parts.join('\n\n');
}

export class ProposalWriter {
  readonly #options: ProposalWriterOptions;
  readonly #active = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #repos = new Map<string, WriteRepo>();
  #login?: string;
  #stopped = false;

  constructor(options: ProposalWriterOptions) {
    this.#options = options;
  }

  /** Start (or queue another) write run for a proposal. Never rejects. */
  kick(id: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const active = this.#active.get(id);
    if (active) {
      this.#again.add(id);
      return active;
    }
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    const run = this.#run(id)
      .catch((error: unknown) => this.#options.onError?.(id, this.#message(error)))
      .finally(() => {
        this.#active.delete(id);
        if (this.#again.delete(id)) void this.kick(id);
      });
    this.#active.set(id, run);
    return run;
  }

  /** Resume every approved proposal left unfinished, e.g. at startup. */
  async resumeAll(): Promise<void> {
    await Promise.all(this.#options.store.listProposals('approved').map(proposal => this.kick(proposal.id)));
  }

  status(id: string): WriteStatus {
    const { attempts: _, ...stored } = this.#load(id);
    return { running: this.#active.has(id), ...stored };
  }

  /** Cancel pending retries and wait for running writes. Abort the client's signal first to cut them short. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    while (this.#active.size > 0) await Promise.all(this.#active.values());
  }

  async #run(id: string): Promise<void> {
    const { store } = this.#options;
    const proposal = store.getProposal(id);
    if (!proposal || proposal.state !== 'approved') return;
    const status = this.#load(id);
    status.warnings = [];
    const touched = new Set<string>();
    try {
      await this.#write(proposal, status, touched);
      const done = store.transaction(() => {
        const current = store.getProposal(id);
        if (current?.state !== 'approved' || current.nodes.some(node => node.status === 'approved')) return false;
        store.setProposalState(id, 'done');
        return true;
      });
      if (done) status.attempts = [];
      status.error = null;
      status.failures = 0;
      status.retryAt = null;
    } catch (error) {
      status.error = this.#message(error);
      status.failures++;
      status.retryAt = null;
      if (!this.#stopped) {
        const delay = (this.#options.retryDelayMs ?? defaultRetryDelay)(status.failures);
        status.retryAt = new Date(this.#now().getTime() + delay).toISOString();
        const timer = setTimeout(() => {
          this.#timers.delete(id);
          void this.kick(id);
        }, delay);
        timer.unref();
        this.#timers.set(id, timer);
      }
      this.#options.onError?.(id, status.error);
    } finally {
      this.#save(id, status);
      if (touched.size > 0) this.#notify(id, [...touched]);
    }
  }

  async #write(proposal: Proposal, status: StoredStatus, touched: Set<string>): Promise<void> {
    const { client, project } = this.#options;
    // Sent-back nodes stay draft and their whole subtree waits for the next approval.
    const blocked = new Set<string>();
    const work: ProposalNode[] = [];
    for (const node of proposal.nodes) {
      const parentBlocked = node.parentKey !== null && blocked.has(node.parentKey);
      if (parentBlocked || node.status === 'draft' || node.status === 'sent_back') {
        blocked.add(node.key);
        if (node.status === 'approved') status.warnings.push(`node "${node.key}" waits for its parent "${node.parentKey}" to be approved`);
      } else {
        work.push(node);
      }
    }
    if (work.length === 0) return;

    // Resolve every repo and issue type before the first write, so a missing type fails cleanly.
    const typeIds = new Map<string, string>();
    for (const node of work) {
      const repo = await this.#repo(node.repo);
      const owner = node.repo.split('/')[0]!;
      if (repo.issueTypes === null) {
        this.#repos.clear(); // Types are per owner; refetch them all once Por fixes the org.
        throw new Error(`${node.repo} is not owned by an organization, so it has no issue types`);
      }
      const typeId = repo.issueTypes.get(node.type);
      if (typeId === undefined) {
        this.#repos.clear(); // Types are per owner; refetch them all once Por fixes the org.
        throw new Error(`issue type "${node.type}" is missing in the ${owner} organization (needs Phase, Feature and Task)`);
      }
      typeIds.set(node.key, typeId);
    }
    const board = project === null ? null : await getProject(client, project);
    const rootParent = proposal.parent === null ? null : await this.#issueId(proposal.parent);

    const ids = new Map<string, string>();
    for (const node of work) {
      try {
        const parentId = node.parentKey === null ? rootParent : ids.get(node.parentKey);
        if (parentId === undefined) throw new Error(`parent "${node.parentKey}" was not created`);
        const typeId = typeIds.get(node.key)!;
        let issue: CreatedIssue;
        if (node.issueNodeId !== null && node.issueNumber !== null) {
          issue = { id: node.issueNodeId, number: node.issueNumber };
        } else {
          issue = await this.#create(proposal.id, node, typeId, status);
          touched.add(node.repo);
        }
        ids.set(node.key, issue.id);
        if (await this.#finish(node, issue, typeId, parentId, board, status)) touched.add(node.repo);
      } catch (error) {
        throw new Error(`node "${node.key}" (${node.type} "${node.title}"): ${this.#message(error)}`);
      }
    }
  }

  async #create(proposalId: string, node: ProposalNode, issueTypeId: string, status: StoredStatus): Promise<CreatedIssue> {
    const { client, store } = this.#options;
    const marker = writeMarker(proposalId, node.key);
    if (status.attempts.includes(node.key)) {
      // An earlier createIssue may have succeeded without being recorded.
      this.#login ??= await getViewerLogin(client);
      const found = await findIssueByMarker(client, repoRef(node.repo), this.#login, marker);
      if (found) {
        store.recordCreatedIssue(proposalId, node.key, { number: found.number, nodeId: found.id });
        return found;
      }
    } else {
      status.attempts.push(node.key);
      this.#save(proposalId, status);
    }
    const repo = await this.#repo(node.repo);
    const created = await createIssue(client, {
      repositoryId: repo.id, title: node.title, body: issueBody(node, marker), issueTypeId,
    });
    store.recordCreatedIssue(proposalId, node.key, { number: created.number, nodeId: created.id });
    return created;
  }

  /** Bring type, parent link, project item and iteration in line. Returns whether anything was written. */
  async #finish(
    node: ProposalNode, issue: CreatedIssue, typeId: string, parentId: string | null,
    board: WriteProject | null, status: StoredStatus,
  ): Promise<boolean> {
    const { client } = this.#options;
    const ref = `${node.repo}#${issue.number}`;
    const state = await getIssueState(client, issue.id);
    let wrote = false;
    if (state.issueTypeId !== typeId) {
      await setIssueType(client, issue.id, typeId);
      wrote = true;
    }
    if (parentId !== null && state.parentId !== parentId) {
      if (state.parentId !== null) throw new Error(`${ref} is already a sub-issue of a different parent`);
      await addSubIssue(client, parentId, issue.id);
      wrote = true;
    }
    if (board !== null) {
      const item = state.projectItems.find(candidate => candidate.projectId === board.id);
      let itemId = item?.id;
      if (itemId === undefined) {
        itemId = await addProjectItem(client, board.id, issue.id);
        wrote = true;
      }
      if (node.iteration !== null) {
        const wanted = node.iteration.trim().toLowerCase();
        const match = board.iterationField?.iterations
          .find(iteration => iteration.id === node.iteration || iteration.title.toLowerCase() === wanted);
        if (!board.iterationField) {
          status.warnings.push(`project has no Iteration field; ${ref} was added without an iteration`);
        } else if (!match) {
          status.warnings.push(`no iteration "${node.iteration}" in the project; ${ref} was added without one`);
        } else if (item?.iterationId !== match.id) {
          await setIteration(client, { projectId: board.id, itemId, fieldId: board.iterationField.id, iterationId: match.id });
          wrote = true;
        }
      }
    }
    return wrote;
  }

  async #repo(name: string): Promise<WriteRepo> {
    const key = name.toLowerCase();
    let repo = this.#repos.get(key);
    if (!repo) {
      repo = await getWriteRepo(this.#options.client, repoRef(name));
      this.#repos.set(key, repo);
    }
    return repo;
  }

  async #issueId(ref: string): Promise<string> {
    const cached = this.#options.store.getIssue(ref);
    if (cached) return cached.nodeId;
    const { repo, number } = parseRef(ref);
    return await getIssueId(this.#options.client, repoRef(repo), number);
  }

  #notify(id: string, repos: string[]): void {
    void Promise.resolve()
      .then(() => this.#options.onWritten?.(repos))
      .catch((error: unknown) => this.#options.onError?.(id, `sync after write: ${this.#message(error)}`));
  }

  #load(id: string): StoredStatus {
    const empty: StoredStatus = { error: null, warnings: [], failures: 0, retryAt: null, updatedAt: null, attempts: [] };
    const raw = this.#options.store.getMeta(statusKey(id));
    if (raw === null) return empty;
    try {
      return { ...empty, ...JSON.parse(raw) as Partial<StoredStatus> };
    } catch {
      return empty;
    }
  }

  #save(id: string, status: StoredStatus): void {
    status.updatedAt = this.#now().toISOString();
    this.#options.store.setMeta(statusKey(id), JSON.stringify(status));
  }

  #message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return redact(text, this.#options.secrets ?? []);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

function statusKey(id: string): string {
  return `proposal:write:${id}`;
}

function repoRef(name: string): RepoRef {
  const [owner, repo] = name.split('/');
  return { owner: owner!, name: repo! };
}

function defaultRetryDelay(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}
