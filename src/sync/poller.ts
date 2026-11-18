import { EventEmitter } from 'node:events';
import type { ProjectRef, RepoRef } from '../config.ts';
import { GitHubClient, GitHubError } from '../github/client.ts';
import { listIssuePullRequests, listIssues, listRepoPullRequests } from '../github/queries.ts';
import type { Issue, PullRequest, RepoPullRequest } from '../github/types.ts';
import type { Secret } from '../secrets.ts';
import type { Store } from '../store/store.ts';
import { mirrorRepo, type SyncChange } from './mirror.ts';

/** `change`: a repo poll wrote new data. `synced`: a repo poll succeeded; carries `Poller#lastSyncAt`. */
export type SyncEvents = { change: [SyncChange]; synced: [number] };

interface SyncClient {
  listIssues(options: { since: string | null; project: ProjectRef | null }): Promise<readonly Issue[]>;
  listIssuePullRequests(nodeIds: readonly string[]): Promise<ReadonlyMap<string, readonly PullRequest[]>>;
  listRepoPullRequests(since: string | null): Promise<readonly RepoPullRequest[]>;
}

interface PollerOptions {
  store: Store;
  repos: readonly RepoRef[];
  project?: ProjectRef | null;
  pollSeconds: number;
  createClient: (repo: RepoRef, signal: AbortSignal) => SyncClient;
  onError?: (repo: string, error: unknown) => void;
  now?: () => number;
}

interface RepoPoll {
  name: string;
  cursorKey: string;
  prCursorKey: string;
  client: SyncClient;
  full: boolean;
  retryAt: number;
  /** Epoch ms of the last successful poll, or null before the first. */
  syncedAt: number | null;
  active?: Promise<void>;
  /** Poll again as soon as the active poll ends. */
  again?: boolean;
}

export function createGitHubPoller({ token, ...options }: Omit<PollerOptions, 'createClient'> & { token: Secret }): Poller {
  return new Poller({
    ...options,
    createClient: (repo, signal) => {
      const client = new GitHubClient(token, { signal });
      return {
        listIssues: options => listIssues(client, repo, options),
        listIssuePullRequests: nodeIds => listIssuePullRequests(client, nodeIds),
        listRepoPullRequests: since => listRepoPullRequests(client, repo, since),
      };
    },
  });
}

export class Poller {
  readonly events = new EventEmitter<SyncEvents>();
  readonly #options: PollerOptions;
  readonly #repos = new Map<string, RepoPoll>();
  readonly #stop = new AbortController();
  readonly #now: () => number;
  #timer?: NodeJS.Timeout;

  constructor(options: PollerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    for (const repo of options.repos) {
      const name = `${repo.owner}/${repo.name}`.toLowerCase();
      if (this.#repos.has(name)) continue;
      this.#repos.set(name, {
        name,
        cursorKey: `sync:since:${name}`,
        prCursorKey: `sync:prs:since:${name}`,
        client: options.createClient(repo, this.#stop.signal),
        full: true,
        retryAt: 0,
        syncedAt: null,
      });
    }
  }

  /** Epoch ms of the oldest repo's last successful poll; null until every repo has synced once. */
  get lastSyncAt(): number | null {
    let oldest: number | null = null;
    for (const repo of this.#repos.values()) {
      if (repo.syncedAt === null) return null;
      if (oldest === null || repo.syncedAt < oldest) oldest = repo.syncedAt;
    }
    return oldest;
  }

  start(): void {
    if (this.#timer || this.#stop.signal.aborted) return;
    this.#timer = setInterval(() => void this.pollOnce(), this.#options.pollSeconds * 1_000);
    void this.pollOnce();
  }

  /** Cancel GitHub requests and wait for all repo polls before the store is closed. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#stop.abort();
    await Promise.all([...this.#repos.values()].map(repo => repo.active));
  }

  async pollOnce(): Promise<void> {
    if (this.#stop.signal.aborted) return;
    const active: Promise<void>[] = [];
    for (const repo of this.#repos.values()) {
      if (!repo.active && this.#now() >= repo.retryAt) this.#start(repo);
      if (repo.active) active.push(repo.active);
    }
    await Promise.all(active);
  }

  /**
   * Poll the given `owner/name` repos (all when omitted) now, e.g. after Orchid wrote to them.
   * A repo already polling is polled again once that poll ends, so it sees the write.
   */
  pollNow(repos?: readonly string[]): void {
    if (this.#stop.signal.aborted) return;
    const wanted = repos && new Set(repos.map(repo => repo.toLowerCase()));
    for (const repo of this.#repos.values()) {
      if (wanted && !wanted.has(repo.name)) continue;
      if (repo.active) repo.again = true;
      else if (this.#now() >= repo.retryAt) this.#start(repo);
    }
  }

  #start(repo: RepoPoll): void {
    repo.active = this.#pollRepo(repo).finally(() => {
      repo.active = undefined;
      if (repo.again && !this.#stop.signal.aborted) {
        repo.again = false;
        this.#start(repo);
      }
    });
  }

  async #pollRepo(repo: RepoPoll): Promise<void> {
    const { store, project = null, onError } = this.#options;
    try {
      const since = repo.full ? null : store.getMeta(repo.cursorKey);
      const issues = await repo.client.listIssues({ since, project });
      if (this.#stop.signal.aborted) return;
      let refreshedPrs: ReadonlyMap<string, readonly PullRequest[]> = new Map();
      if (since !== null) {
        // PR/CI changes don't bump an issue's updatedAt, so re-check unchanged issues.
        // Open issues only: closing an issue bumps updatedAt, and refreshing every closed
        // issue each poll would burn the GraphQL budget across many repos.
        const returned = new Set(issues.map(issue => issue.nodeId));
        const remaining = store.listIssues()
          .filter(issue => issue.repo.toLowerCase() === repo.name && issue.state === 'open' && !returned.has(issue.nodeId))
          .map(issue => issue.nodeId);
        if (remaining.length) refreshedPrs = await repo.client.listIssuePullRequests(remaining);
      }
      if (this.#stop.signal.aborted) return;
      const prSince = repo.full ? null : store.getMeta(repo.prCursorKey);
      const prs = await repo.client.listRepoPullRequests(prSince);
      if (this.#stop.signal.aborted) return;

      const change = mirrorRepo(store, {
        repo: repo.name, cursorKey: repo.cursorKey, since, issues, refreshedPrs,
        prCursorKey: repo.prCursorKey, prSince, prs,
      });
      repo.full = false;
      repo.syncedAt = this.#now();
      if (change.issues.length || change.prs.length) this.events.emit('change', change);
      const lastSyncAt = this.lastSyncAt;
      if (lastSyncAt !== null) this.events.emit('synced', lastSyncAt);
    } catch (error) {
      if (this.#stop.signal.aborted) return;
      if (error instanceof GitHubError && error.retryAfterMs !== undefined) {
        repo.retryAt = this.#now() + error.retryAfterMs;
      }
      onError?.(repo.name, error);
    }
  }
}
