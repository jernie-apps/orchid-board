import { createHash, randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { type DB, openDb, tx } from './db.ts';
import { formatRef, isRef, parseRef } from './ref.ts';

export type IssueType = 'Phase' | 'Feature' | 'Task';
export type IssueState = 'open' | 'closed';
export type PrState = 'open' | 'closed' | 'merged';
export type ChecksRollup = 'pass' | 'fail' | 'running' | 'none';
export type ProposalState = 'pending' | 'approved' | 'done' | 'rejected';
/** draft: awaiting review. sent_back: Por asked for changes. approved: ready to write. created: issue exists in GitHub. */
export type NodeStatus = 'draft' | 'sent_back' | 'approved' | 'created';

export interface Iteration {
  id: string;
  title: string;
}

export interface IssueInput {
  /** `owner/name#number` */
  ref: string;
  nodeId: string;
  type: IssueType | null;
  title: string;
  state: IssueState;
  /** Parent issue ref, possibly in another repo. */
  parent: string | null;
  iteration: Iteration | null;
  /** GitHub's ISO timestamp, stored as given. */
  updatedAt: string;
}

export interface Issue extends IssueInput {
  repo: string;
  number: number;
}

export interface PrInput {
  ref: string;
  url: string;
  title: string;
  state: PrState;
  draft: boolean;
  /** Issue refs this PR closes / links to. Replaces the previous set. */
  issues: string[];
  updatedAt: string;
  /** Omitted: keep the stored rollup (or 'none'). */
  checks?: ChecksRollup;
}

export interface Pr extends Omit<PrInput, 'checks'> {
  repo: string;
  number: number;
  checks: ChecksRollup;
}

export interface Claim {
  task: string;
  agent: string;
  since: string;
  expiresAt: string;
}

/** An agent's local "done" signal for a task. Not written to GitHub. */
export interface DoneReport {
  task: string;
  agent: string;
  at: string;
}

export interface TreeNode extends Issue {
  children: TreeNode[];
  prs: Pr[];
  claim: Claim | null;
}

export interface Tree {
  /** Phases, with Features and Tasks nested under them. */
  roots: TreeNode[];
  /**
   * Issues with no type, or a Feature/Task whose parent is missing, out of the filter
   * result, or not a higher level. Their own children stay nested.
   */
  orphans: TreeNode[];
}

export interface TreeFilter {
  repo?: string;
  /** Iteration id or title. */
  iteration?: string;
  state?: IssueState;
}

export interface ProposalNodeInput {
  /** Caller-chosen key, unique within the proposal. */
  key: string;
  /** Key of the parent node in the same proposal; must appear earlier in the list. */
  parentKey?: string | null;
  repo: string;
  type: IssueType;
  title: string;
  body?: string;
  branch?: string | null;
  iteration?: string | null;
}

export interface ProposalNode {
  key: string;
  parentKey: string | null;
  position: number;
  repo: string;
  type: IssueType;
  title: string;
  body: string;
  branch: string | null;
  iteration: string | null;
  status: NodeStatus;
  issueNumber: number | null;
  issueNodeId: string | null;
}

export interface Proposal {
  id: string;
  /** Existing issue the tree attaches under, if any. */
  parent: string | null;
  agent: string | null;
  state: ProposalState;
  createdAt: string;
  updatedAt: string;
  /** Parents before children, in submitted order. */
  nodes: ProposalNode[];
}

export interface Feedback {
  id: number;
  proposalId: string;
  nodeKey: string | null;
  author: string;
  body: string;
  createdAt: string;
}

export type ApproveResult = { ok: true } | { ok: false; reason: 'missing' | 'wrong' | 'expired' | 'used' | 'locked' };

export class StoreError extends Error {
  override name = 'StoreError';
}

export class ClaimConflictError extends StoreError {
  override name = 'ClaimConflictError';
  readonly task: string;
  readonly holder: string;
  readonly expiresAt: string;

  constructor(claim: Claim) {
    super(`${claim.task} is claimed by ${claim.agent} until ${claim.expiresAt}`);
    this.task = claim.task;
    this.holder = claim.agent;
    this.expiresAt = claim.expiresAt;
  }
}

export interface StoreOptions {
  /** Clock for claims, proposals and codes. Defaults to the system clock. */
  now?: () => Date;
}

type Row = Record<string, SQLOutputValue>;

const RANK: Record<IssueType, number> = { Phase: 0, Feature: 1, Task: 2 };
const MAX_APPROVE_ATTEMPTS = 5;

export function openStore(path: string, options: StoreOptions = {}): Store {
  return new Store(openDb(path), options);
}

/** Typed repo layer over board.db. All refs are `owner/name#number`. */
export class Store {
  readonly db: DB;
  readonly #clock: () => Date;

  constructor(db: DB, options: StoreOptions = {}) {
    this.db = db;
    this.#clock = options.now ?? (() => new Date());
  }

  transaction<T>(fn: () => T): T {
    return tx(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  // ---- meta ----

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- issues ----

  upsertIssue(input: IssueInput): void {
    const { repo, number } = parseRef(input.ref);
    if (input.parent !== null && !isRef(input.parent)) throw new StoreError(`invalid parent ref "${input.parent}"`);
    tx(this.db, () => {
      // A transferred issue keeps its node_id under a new (repo, number).
      this.db.prepare('DELETE FROM issues WHERE node_id = ? AND NOT (repo = ? AND number = ?)').run(input.nodeId, repo, number);
      this.db
        .prepare(
          `INSERT INTO issues (repo, number, node_id, type, title, state, parent, iteration_id, iteration_title, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo, number) DO UPDATE SET
             node_id = excluded.node_id, type = excluded.type, title = excluded.title, state = excluded.state,
             parent = excluded.parent, iteration_id = excluded.iteration_id,
             iteration_title = excluded.iteration_title, updated_at = excluded.updated_at`,
        )
        .run(
          repo,
          number,
          input.nodeId,
          input.type,
          input.title,
          input.state,
          input.parent,
          input.iteration?.id ?? null,
          input.iteration?.title ?? null,
          input.updatedAt,
        );
    });
  }

  upsertIssues(inputs: readonly IssueInput[]): void {
    tx(this.db, () => {
      for (const input of inputs) this.upsertIssue(input);
    });
  }

  deleteIssue(ref: string): boolean {
    const { repo, number } = parseRef(ref);
    return Number(this.db.prepare('DELETE FROM issues WHERE repo = ? AND number = ?').run(repo, number).changes) > 0;
  }

  getIssue(ref: string): Issue | null {
    const { repo, number } = parseRef(ref);
    const row = this.db.prepare('SELECT * FROM issues WHERE repo = ? AND number = ?').get(repo, number);
    return row ? toIssue(row) : null;
  }

  /** Issues matching the filter, ordered by repo then number. */
  listIssues(filter: TreeFilter = {}): Issue[] {
    return this.#allIssues().filter((issue) => matches(issue, filter));
  }

  /**
   * Phase → Feature → Task nesting. The filter selects issues; their ancestors are
   * included too so matches keep their place in the tree.
   */
  getTree(filter: TreeFilter = {}): Tree {
    const all = this.#allIssues();
    const byRef = new Map(all.map((issue) => [issue.ref, issue]));
    const included = new Set<string>();
    for (const issue of all) {
      if (!matches(issue, filter)) continue;
      let current: Issue | undefined = issue;
      while (current && !included.has(current.ref)) {
        included.add(current.ref);
        current = current.parent ? byRef.get(current.parent) : undefined;
      }
    }

    const prs = this.#prsByIssue();
    const claims = new Map(this.listClaims().map((claim) => [claim.task, claim]));
    const nodes = new Map<string, TreeNode>();
    for (const issue of all) {
      if (included.has(issue.ref)) {
        nodes.set(issue.ref, { ...issue, children: [], prs: prs.get(issue.ref) ?? [], claim: claims.get(issue.ref) ?? null });
      }
    }

    const tree: Tree = { roots: [], orphans: [] };
    for (const node of nodes.values()) {
      if (node.type === null) {
        tree.orphans.push(node);
      } else if (node.type === 'Phase') {
        tree.roots.push(node);
      } else {
        const parent = node.parent ? nodes.get(node.parent) : undefined;
        // Under a typeless parent the node stays nested in that orphan rather than floating free.
        if (parent && (parent.type === null || RANK[parent.type] < RANK[node.type])) parent.children.push(node);
        else tree.orphans.push(node);
      }
    }
    return tree;
  }

  #allIssues(): Issue[] {
    return this.db.prepare('SELECT * FROM issues ORDER BY repo, number').all().map(toIssue);
  }

  // ---- PRs and checks ----

  /** Write reported GitHub links and any additional links from the PR body. */
  upsertPr(input: PrInput, bodyIssues: readonly string[] = []): void {
    const { repo, number } = parseRef(input.ref);
    const github = new Set(input.issues);
    const body = new Set(bodyIssues);
    const issues = new Set([...github, ...body]);
    for (const issue of issues) if (!isRef(issue)) throw new StoreError(`invalid issue ref "${issue}"`);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO prs (repo, number, url, title, state, draft, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo, number) DO UPDATE SET url = excluded.url, title = excluded.title,
             state = excluded.state, draft = excluded.draft, updated_at = excluded.updated_at`,
        )
        .run(repo, number, input.url, input.title, input.state, input.draft ? 1 : 0, input.updatedAt);
      this.db.prepare('DELETE FROM pr_issues WHERE pr_repo = ? AND pr_number = ?').run(repo, number);
      const link = this.db.prepare('INSERT INTO pr_issues (pr_repo, pr_number, issue, source) VALUES (?, ?, ?, ?)');
      for (const issue of issues) {
        const source = github.has(issue) ? (body.has(issue) ? 'both' : 'github') : 'body';
        link.run(repo, number, issue, source);
      }
      if (input.checks) this.setChecks(input.ref, input.checks);
    });
  }

  setChecks(prRef: string, rollup: ChecksRollup): void {
    const { repo, number } = parseRef(prRef);
    this.db
      .prepare(
        `INSERT INTO checks (pr_repo, pr_number, rollup) VALUES (?, ?, ?)
         ON CONFLICT(pr_repo, pr_number) DO UPDATE SET rollup = excluded.rollup`,
      )
      .run(repo, number, rollup);
  }

  deletePr(ref: string): boolean {
    const { repo, number } = parseRef(ref);
    return Number(this.db.prepare('DELETE FROM prs WHERE repo = ? AND number = ?').run(repo, number).changes) > 0;
  }

  getPr(ref: string): Pr | null {
    const { repo, number } = parseRef(ref);
    const row = this.db
      .prepare(
        `SELECT p.*, c.rollup FROM prs p LEFT JOIN checks c ON c.pr_repo = p.repo AND c.pr_number = p.number
         WHERE p.repo = ? AND p.number = ?`,
      )
      .get(repo, number);
    if (!row) return null;
    const issues = this.db
      .prepare('SELECT issue FROM pr_issues WHERE pr_repo = ? AND pr_number = ? ORDER BY issue')
      .all(repo, number)
      .map((r) => String(r.issue));
    return toPr(row, issues);
  }

  prsForIssue(ref: string): Pr[] {
    parseRef(ref);
    return this.#prsByIssue().get(ref) ?? [];
  }

  listPrs(): Pr[] {
    return this.listPrsWithLinks().map(({ pr }) => pr);
  }

  listPrsWithLinks(): { pr: Pr; githubIssues: string[]; bodyIssues: string[] }[] {
    const links = new Map<string, { issues: string[]; githubIssues: string[]; bodyIssues: string[] }>();
    const linkRows = this.db
      .prepare('SELECT pr_repo, pr_number, issue, source FROM pr_issues ORDER BY issue')
      .all();
    for (const row of linkRows) {
      const ref = formatRef(String(row.pr_repo), Number(row.pr_number));
      const group = links.get(ref) ?? { issues: [], githubIssues: [], bodyIssues: [] };
      const issue = String(row.issue);
      group.issues.push(issue);
      if (row.source !== 'body') group.githubIssues.push(issue);
      if (row.source !== 'github') group.bodyIssues.push(issue);
      links.set(ref, group);
    }
    const rows = this.db
      .prepare(
        `SELECT p.*, c.rollup FROM prs p
         LEFT JOIN checks c ON c.pr_repo = p.repo AND c.pr_number = p.number
         ORDER BY p.repo, p.number`,
      )
      .all();
    return rows.map(row => {
      const { issues = [], githubIssues = [], bodyIssues = [] } = links.get(formatRef(String(row.repo), Number(row.number))) ?? {};
      return { pr: toPr(row, issues), githubIssues, bodyIssues };
    });
  }

  #prsByIssue(): Map<string, Pr[]> {
    const out = new Map<string, Pr[]>();
    for (const pr of this.listPrs()) {
      for (const issue of pr.issues) {
        const prs = out.get(issue);
        const entry = { ...pr };
        if (prs) prs.push(entry);
        else out.set(issue, [entry]);
      }
    }
    return out;
  }

  // ---- claims ----

  /**
   * Claim a task for `ttlMs`. The same agent re-claiming renews the expiry and keeps `since`.
   * Throws ClaimConflictError naming the holder if another agent's claim is still active.
   */
  claim(task: string, agent: string, options: { ttlMs: number; now?: Date }): Claim {
    parseRef(task);
    if (agent === '') throw new StoreError('agent must be non-empty');
    if (!(options.ttlMs > 0)) throw new StoreError('ttlMs must be positive');
    const now = options.now ?? this.#clock();
    const nowIso = now.toISOString();
    return tx(this.db, () => {
      const existing = this.#claimRow(task);
      const active = existing && existing.expiresAt > nowIso ? existing : null;
      if (active && active.agent !== agent) throw new ClaimConflictError(active);
      const claim: Claim = {
        task,
        agent,
        since: active?.since ?? nowIso,
        expiresAt: new Date(now.getTime() + options.ttlMs).toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO claims (task, agent, since, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, since = excluded.since, expires_at = excluded.expires_at`,
        )
        .run(claim.task, claim.agent, claim.since, claim.expiresAt);
      // A new claim means work restarted: drop any earlier done signal.
      const { repo, number } = parseRef(task);
      this.db.prepare('UPDATE issues SET done_by = NULL, done_at = NULL WHERE repo = ? AND number = ?').run(repo, number);
      return claim;
    });
  }

  /**
   * Drop the claim on a task. With `agent`, throws ClaimConflictError if another agent
   * holds an active claim. Returns false when there was no claim.
   */
  release(task: string, agent?: string, now: Date = this.#clock()): boolean {
    parseRef(task);
    return tx(this.db, () => {
      const existing = this.#claimRow(task);
      if (!existing) return false;
      if (agent !== undefined && existing.agent !== agent && existing.expiresAt > now.toISOString()) {
        throw new ClaimConflictError(existing);
      }
      this.db.prepare('DELETE FROM claims WHERE task = ?').run(task);
      return true;
    });
  }

  /** Active claim on a task, or null (expired claims are ignored). */
  getClaim(task: string, now: Date = this.#clock()): Claim | null {
    const claim = this.#claimRow(task);
    return claim && claim.expiresAt > now.toISOString() ? claim : null;
  }

  listClaims(now: Date = this.#clock()): Claim[] {
    return this.db
      .prepare('SELECT * FROM claims WHERE expires_at > ? ORDER BY task')
      .all(now.toISOString())
      .map(toClaim);
  }

  /** Delete expired claims. Returns how many were removed. */
  purgeExpiredClaims(now: Date = this.#clock()): number {
    return Number(this.db.prepare('DELETE FROM claims WHERE expires_at <= ?').run(now.toISOString()).changes);
  }

  /**
   * Record that `agent` reported the task done and drop its claim. Local signal only.
   * Throws ClaimConflictError if another agent holds an active claim, StoreError if the task is not cached.
   */
  markDone(task: string, agent: string, now: Date = this.#clock()): DoneReport {
    const { repo, number } = parseRef(task);
    if (agent === '') throw new StoreError('agent must be non-empty');
    return tx(this.db, () => {
      if (!this.getIssue(task)) throw new StoreError(`unknown task ${task}`);
      this.release(task, agent, now);
      const at = now.toISOString();
      this.db.prepare('UPDATE issues SET done_by = ?, done_at = ? WHERE repo = ? AND number = ?').run(agent, at, repo, number);
      return { task, agent, at };
    });
  }

  /** The latest done signal for a task, or null. */
  getDone(task: string): DoneReport | null {
    const { repo, number } = parseRef(task);
    const row = this.db.prepare('SELECT done_by, done_at FROM issues WHERE repo = ? AND number = ?').get(repo, number);
    if (!row || row.done_by === null || row.done_at === null) return null;
    return { task, agent: String(row.done_by), at: String(row.done_at) };
  }

  #claimRow(task: string): Claim | null {
    const row = this.db.prepare('SELECT * FROM claims WHERE task = ?').get(task);
    return row ? toClaim(row) : null;
  }

  // ---- proposals ----

  /** Store a draft tree. Integrity only (unique keys, parents first); level/type rules belong to src/proposals. */
  createProposal(
    input: { parent?: string | null; agent?: string | null; nodes: readonly ProposalNodeInput[] },
    now: Date = this.#clock(),
  ): Proposal {
    const parent = input.parent ?? null;
    if (parent !== null && !isRef(parent)) throw new StoreError(`invalid parent ref "${parent}"`);
    if (input.nodes.length === 0) throw new StoreError('proposal needs at least one node');
    const seen = new Set<string>();
    for (const node of input.nodes) {
      if (node.key === '') throw new StoreError('node key must be non-empty');
      if (seen.has(node.key)) throw new StoreError(`duplicate node key "${node.key}"`);
      if (node.parentKey != null && !seen.has(node.parentKey)) {
        throw new StoreError(`node "${node.key}": parent "${node.parentKey}" must appear earlier in the list`);
      }
      seen.add(node.key);
    }
    const id = `prop_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const at = now.toISOString();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO proposals (id, parent, agent, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
        .run(id, parent, input.agent ?? null, at, at);
      this.#insertProposalNodes(id, input.nodes, 0);
    });
    return this.getProposal(id)!;
  }

  #insertProposalNodes(id: string, nodes: readonly ProposalNodeInput[], offset: number): void {
    const insert = this.db.prepare(
      `INSERT INTO proposal_nodes (proposal_id, key, parent_key, position, repo, type, title, body, branch, iteration, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    );
    nodes.forEach((node, index) => {
      insert.run(
        id,
        node.key,
        node.parentKey ?? null,
        offset + index,
        node.repo,
        node.type,
        node.title,
        node.body ?? '',
        node.branch ?? null,
        node.iteration ?? null,
      );
    });
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!row) return null;
    const nodes = this.db
      .prepare('SELECT * FROM proposal_nodes WHERE proposal_id = ? ORDER BY position')
      .all(id)
      .map(toProposalNode);
    return toProposal(row, nodes);
  }

  listProposals(state?: ProposalState): Proposal[] {
    const rows = state
      ? this.db.prepare('SELECT id FROM proposals WHERE state = ? ORDER BY created_at, id').all(state)
      : this.db.prepare('SELECT id FROM proposals ORDER BY created_at, id').all();
    return rows.map((row) => this.getProposal(String(row.id))!);
  }

  setProposalState(id: string, state: ProposalState, now: Date = this.#clock()): void {
    const changes = this.db
      .prepare('UPDATE proposals SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, now.toISOString(), id).changes;
    if (Number(changes) === 0) throw new StoreError(`no proposal ${id}`);
  }

  setNodeStatus(id: string, key: string, status: NodeStatus): void {
    const changes = this.db
      .prepare('UPDATE proposal_nodes SET status = ? WHERE proposal_id = ? AND key = ?')
      .run(status, id, key).changes;
    if (Number(changes) === 0) throw new StoreError(`no node "${key}" in proposal ${id}`);
  }

  /** Mark a node sent back and record the reviewer's comment. */
  sendBack(id: string, key: string, comment: { author: string; body: string }, now: Date = this.#clock()): void {
    tx(this.db, () => {
      this.setNodeStatus(id, key, 'sent_back');
      this.addFeedback(id, key, comment.author, comment.body, now);
    });
  }

  addFeedback(id: string, nodeKey: string | null, author: string, body: string, now: Date = this.#clock()): Feedback {
    const createdAt = now.toISOString();
    const rowId = tx(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM proposals WHERE id = ?').get(id)) throw new StoreError(`no proposal ${id}`);
      const result = this.db
        .prepare('INSERT INTO feedback (proposal_id, node_key, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, nodeKey, author, body, createdAt);
      this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(createdAt, id);
      return Number(result.lastInsertRowid);
    });
    return { id: rowId, proposalId: id, nodeKey, author, body, createdAt };
  }

  /** Sent-back nodes plus every comment on the proposal, oldest first. */
  getFeedback(id: string): { sentBack: ProposalNode[]; comments: Feedback[] } {
    const sentBack = this.db
      .prepare("SELECT * FROM proposal_nodes WHERE proposal_id = ? AND status = 'sent_back' ORDER BY position")
      .all(id)
      .map(toProposalNode);
    const comments = this.db
      .prepare('SELECT * FROM feedback WHERE proposal_id = ? ORDER BY id')
      .all(id)
      .map(toFeedback);
    return { sentBack, comments };
  }

  /** Replace content of sent-back nodes (structure is kept) and return them to draft. */
  resubmitNodes(id: string, nodes: readonly ProposalNodeInput[], now: Date = this.#clock()): Proposal {
    tx(this.db, () => {
      const status = this.db.prepare('SELECT status FROM proposal_nodes WHERE proposal_id = ? AND key = ?');
      const update = this.db.prepare(
        `UPDATE proposal_nodes SET repo = ?, type = ?, title = ?, body = ?, branch = ?, iteration = ?, status = 'draft'
         WHERE proposal_id = ? AND key = ?`,
      );
      for (const node of nodes) {
        const row = status.get(id, node.key);
        if (!row) throw new StoreError(`no node "${node.key}" in proposal ${id}`);
        if (row.status !== 'sent_back') throw new StoreError(`node "${node.key}" was not sent back`);
        update.run(node.repo, node.type, node.title, node.body ?? '', node.branch ?? null, node.iteration ?? null, id, node.key);
      }
      this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(now.toISOString(), id);
      if (nodes.length > 0) this.#invalidateApproveCode(id);
    });
    return this.getProposal(id)!;
  }

  /** Replace entire sent-back subtrees, preserving the other nodes and their order. */
  resubmitSubtrees(
    id: string,
    rootKeys: ReadonlySet<string>,
    prepare: (proposal: Proposal, retained: readonly ProposalNode[]) => ReadonlyMap<string, readonly ProposalNodeInput[]>,
    now: Date = this.#clock(),
  ): Proposal {
    return tx(this.db, () => {
      const proposal = this.getProposal(id);
      if (!proposal) throw new StoreError(`no proposal ${id}`);
      if (proposal.state === 'rejected') throw new StoreError('a rejected proposal cannot be resubmitted');
      if (rootKeys.size === 0) throw new StoreError('resubmission needs at least one sent-back node');
      const removed = new Set<string>();
      const retained: ProposalNode[] = [];
      for (const node of proposal.nodes) {
        const underReplacement = node.parentKey !== null && removed.has(node.parentKey);
        if (rootKeys.has(node.key)) {
          if (node.status !== 'sent_back') throw new StoreError(`node "${node.key}" was not sent back`);
          if (underReplacement) throw new StoreError(`include "${node.key}" inside its replacement subtree`);
        } else if (!underReplacement) {
          retained.push(node);
          continue;
        }
        if (node.status === 'approved' || node.status === 'created') {
          throw new StoreError(`cannot replace ${node.status} node "${node.key}"`);
        }
        removed.add(node.key);
      }
      for (const key of rootKeys) {
        if (!removed.has(key)) throw new StoreError(`no node "${key}" in proposal ${id}`);
      }
      const replacements = prepare(proposal, retained);
      const remove = this.db.prepare('DELETE FROM proposal_nodes WHERE proposal_id = ? AND key = ?');
      for (const key of removed) remove.run(id, key);
      const move = this.db.prepare('UPDATE proposal_nodes SET position = ? WHERE proposal_id = ? AND key = ?');
      let position = 0;
      for (const node of proposal.nodes) {
        const replacement = replacements.get(node.key);
        if (rootKeys.has(node.key)) {
          if (!replacement?.length || replacement[0]!.key !== node.key || replacement[0]!.parentKey !== node.parentKey) {
            throw new StoreError(`replacement must keep the key and parent of "${node.key}"`);
          }
          this.#insertProposalNodes(id, replacement, position);
          position += replacement.length;
        } else if (!removed.has(node.key)) {
          if (node.position !== position) move.run(position, id, node.key);
          position++;
        }
      }
      this.setProposalState(id, 'pending', now);
      this.#invalidateApproveCode(id);
      return this.getProposal(id)!;
    });
  }

  /** A branch recorded by Orchid when it created the cached issue. */
  getCreatedIssueBranch(issueNodeId: string): string | null {
    const row = this.db
      .prepare('SELECT branch FROM proposal_nodes WHERE issue_node_id = ? AND branch IS NOT NULL LIMIT 1')
      .get(issueNodeId);
    return strOrNull(row?.branch);
  }

  /**
   * Record the GitHub issue created for a node so a resumed write skips it.
   * Repeating with the same number is a no-op; a different number throws.
   */
  recordCreatedIssue(id: string, key: string, issue: { number: number; nodeId: string }): void {
    tx(this.db, () => {
      const row = this.db.prepare('SELECT issue_number FROM proposal_nodes WHERE proposal_id = ? AND key = ?').get(id, key);
      if (!row) throw new StoreError(`no node "${key}" in proposal ${id}`);
      if (row.issue_number !== null && Number(row.issue_number) !== issue.number) {
        throw new StoreError(`node "${key}" already created as #${row.issue_number}`);
      }
      this.db
        .prepare("UPDATE proposal_nodes SET issue_number = ?, issue_node_id = ?, status = 'created' WHERE proposal_id = ? AND key = ?")
        .run(issue.number, issue.nodeId, id, key);
    });
  }

  // ---- review edits (web inbox) ----

  /** Rename a draft node of a pending proposal. Its branch keeps the name derived when it was proposed. */
  renameProposalNode(id: string, key: string, title: string, now: Date = this.#clock()): void {
    const clean = title.trim();
    if (clean === '') throw new StoreError('title must be non-empty');
    if (clean.length > MAX_TITLE) throw new StoreError(`title must be at most ${MAX_TITLE} characters`);
    tx(this.db, () => {
      const node = this.#reviewableNode(id, key);
      if (node.title === clean) return;
      this.db.prepare('UPDATE proposal_nodes SET title = ? WHERE proposal_id = ? AND key = ?').run(clean, id, key);
      this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(now.toISOString(), id);
    });
  }

  /**
   * Drop a node and its subtree from a pending proposal. Reversible until approval;
   * approveProposal deletes dropped subtrees so they never reach GitHub.
   */
  dropProposalNode(id: string, key: string): void {
    tx(this.db, () => {
      this.#reviewableNode(id, key, true);
      const proposal = this.getProposal(id)!;
      const subtree = subtreeOf(proposal.nodes, key);
      const fixed = proposal.nodes.find(node => subtree.has(node.key) && (node.status === 'approved' || node.status === 'created'));
      if (fixed) throw new StoreError(`node "${fixed.key}" is already ${fixed.status} and cannot be dropped`);
      const dropped = new Set(this.droppedNodeKeys(id));
      dropped.add(key);
      this.setMeta(droppedKey(id), JSON.stringify([...dropped]));
    });
  }

  restoreProposalNode(id: string, key: string): void {
    tx(this.db, () => {
      this.#reviewableNode(id, key, true);
      const dropped = this.droppedNodeKeys(id).filter(k => k !== key);
      this.setMeta(droppedKey(id), JSON.stringify(dropped));
    });
  }

  /** Node keys Por dropped directly (their subtrees are dropped with them). */
  droppedNodeKeys(id: string): string[] {
    const raw = this.getMeta(droppedKey(id));
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  #reviewableNode(id: string, key: string, allowSentBack = false): ProposalNode {
    const proposal = this.getProposal(id);
    if (!proposal) throw new StoreError(`no proposal ${id}`);
    if (proposal.state !== 'pending') throw new StoreError('only pending proposals can be edited');
    const node = proposal.nodes.find(n => n.key === key);
    if (!node) throw new StoreError(`no node "${key}" in proposal ${id}`);
    if (node.status !== 'draft' && !(allowSentBack && node.status === 'sent_back')) {
      throw new StoreError(`node "${key}" is ${node.status} and cannot be edited`);
    }
    return node;
  }

  // ---- approve codes ----

  #invalidateApproveCode(id: string): void {
    this.db.prepare('DELETE FROM approve_codes WHERE proposal_id = ? AND used_at IS NULL').run(id);
  }

  /** Store a new code for a proposal (hash only), replacing any previous one. */
  saveApproveCode(id: string, code: string, expiresAt: Date, now: Date = this.#clock()): void {
    if (code === '') throw new StoreError('approve code must be non-empty');
    if (!this.db.prepare('SELECT 1 FROM proposals WHERE id = ?').get(id)) throw new StoreError(`no proposal ${id}`);
    this.db
      .prepare(
        `INSERT INTO approve_codes (proposal_id, code_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(proposal_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at,
           expires_at = excluded.expires_at, used_at = NULL, failed_attempts = 0`,
      )
      .run(id, hashCode(id, code), now.toISOString(), expiresAt.toISOString());
  }

  /** Succeeds once for the right, unexpired code. The fifth wrong guess burns it. */
  consumeApproveCode(id: string, code: string, now: Date = this.#clock()): ApproveResult {
    return tx(this.db, () => {
      const at = now.toISOString();
      const row = this.db
        .prepare('SELECT code_hash, expires_at, used_at, failed_attempts FROM approve_codes WHERE proposal_id = ?')
        .get(id);
      if (!row) return { ok: false, reason: 'missing' };
      if (row.used_at !== null) return { ok: false, reason: 'used' };
      const attempts = Number(row.failed_attempts);
      if (attempts >= MAX_APPROVE_ATTEMPTS) return { ok: false, reason: 'locked' };
      if (String(row.expires_at) <= at) return { ok: false, reason: 'expired' };
      if (row.code_hash !== hashCode(id, code)) {
        this.db.prepare('UPDATE approve_codes SET failed_attempts = failed_attempts + 1 WHERE proposal_id = ?').run(id);
        return { ok: false, reason: attempts + 1 === MAX_APPROVE_ATTEMPTS ? 'locked' : 'wrong' };
      }
      this.db.prepare('UPDATE approve_codes SET used_at = ? WHERE proposal_id = ?').run(at, id);
      return { ok: true };
    });
  }

  /** Consume the code and release reviewed draft nodes to the GitHub writer in one transaction. */
  approveProposal(id: string, code: string, now: Date = this.#clock()): ApproveResult {
    return tx(this.db, () => {
      const result = this.consumeApproveCode(id, code, now);
      if (!result.ok) return result;
      const proposal = this.getProposal(id)!;
      if (proposal.state !== 'pending') throw new StoreError('only pending proposals can be approved');
      const plan = approvalPlan(proposal, this.droppedNodeKeys(id));
      const remove = this.db.prepare('DELETE FROM proposal_nodes WHERE proposal_id = ? AND key = ?');
      for (const key of plan.dropped) remove.run(id, key);
      for (const key of plan.approve) this.setNodeStatus(id, key, 'approved');
      if (plan.approve.length === 0) throw new StoreError('proposal has no draft nodes ready for approval');
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(droppedKey(id));
      this.setProposalState(id, 'approved', now);
      return result;
    });
  }
}

const MAX_TITLE = 256;

function droppedKey(id: string): string {
  return `proposal.dropped:${id}`;
}

/** Keys of `root` and every node below it. Nodes are ordered parents first. */
function subtreeOf(nodes: readonly ProposalNode[], root: string): Set<string> {
  const keys = new Set([root]);
  for (const node of nodes) if (node.parentKey !== null && keys.has(node.parentKey)) keys.add(node.key);
  return keys;
}

/**
 * What approval would do. `dropped`: draft or sent-back nodes removed with a dropped ancestor (or themselves).
 * `approve`: draft nodes that become approved; a sent-back node holds back its whole subtree.
 * The web inbox shows the same numbers, so the label and the store never disagree.
 */
export function approvalPlan(proposal: Pick<Proposal, 'nodes'>, droppedKeys: Iterable<string>): { dropped: string[]; approve: string[] } {
  const direct = new Set(droppedKeys);
  const dropped = new Set<string>();
  const blocked = new Set<string>();
  const approve: string[] = [];
  for (const node of proposal.nodes) {
    const parent = node.parentKey;
    if (direct.has(node.key) || (parent !== null && dropped.has(parent))) {
      if (node.status === 'approved' || node.status === 'created') throw new StoreError(`cannot drop ${node.status} node "${node.key}"`);
      dropped.add(node.key);
    } else if (node.status === 'sent_back' || (parent !== null && blocked.has(parent))) {
      blocked.add(node.key);
    } else if (node.status === 'draft') {
      approve.push(node.key);
    }
  }
  return { dropped: [...dropped], approve };
}

function hashCode(proposalId: string, code: string): string {
  return createHash('sha256').update(`${proposalId}:${code}`).digest('hex');
}

function matches(issue: Issue, filter: TreeFilter): boolean {
  if (filter.repo !== undefined && issue.repo !== filter.repo) return false;
  if (filter.state !== undefined && issue.state !== filter.state) return false;
  if (filter.iteration !== undefined) {
    if (!issue.iteration) return false;
    if (issue.iteration.id !== filter.iteration && issue.iteration.title !== filter.iteration) return false;
  }
  return true;
}

function strOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIssue(row: Row): Issue {
  const repo = String(row.repo);
  const number = Number(row.number);
  const iterationId = strOrNull(row.iteration_id);
  return {
    ref: formatRef(repo, number),
    repo,
    number,
    nodeId: String(row.node_id),
    type: strOrNull(row.type) as IssueType | null,
    title: String(row.title),
    state: String(row.state) as IssueState,
    parent: strOrNull(row.parent),
    iteration: iterationId === null ? null : { id: iterationId, title: String(row.iteration_title ?? '') },
    updatedAt: String(row.updated_at),
  };
}

function toPr(row: Row, issues: string[]): Pr {
  const repo = String(row.repo);
  const number = Number(row.number);
  return {
    ref: formatRef(repo, number),
    repo,
    number,
    url: String(row.url),
    title: String(row.title),
    state: String(row.state) as PrState,
    draft: Number(row.draft) === 1,
    issues,
    updatedAt: String(row.updated_at),
    checks: (strOrNull(row.rollup) ?? 'none') as ChecksRollup,
  };
}

function toClaim(row: Row): Claim {
  return { task: String(row.task), agent: String(row.agent), since: String(row.since), expiresAt: String(row.expires_at) };
}

function toProposal(row: Row, nodes: ProposalNode[]): Proposal {
  return {
    id: String(row.id),
    parent: strOrNull(row.parent),
    agent: strOrNull(row.agent),
    state: String(row.state) as ProposalState,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    nodes,
  };
}

function toProposalNode(row: Row): ProposalNode {
  return {
    key: String(row.key),
    parentKey: strOrNull(row.parent_key),
    position: Number(row.position),
    repo: String(row.repo),
    type: String(row.type) as IssueType,
    title: String(row.title),
    body: String(row.body),
    branch: strOrNull(row.branch),
    iteration: strOrNull(row.iteration),
    status: String(row.status) as NodeStatus,
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    issueNodeId: strOrNull(row.issue_node_id),
  };
}

function toFeedback(row: Row): Feedback {
  return {
    id: Number(row.id),
    proposalId: String(row.proposal_id),
    nodeKey: strOrNull(row.node_key),
    author: String(row.author),
    body: String(row.body),
    createdAt: String(row.created_at),
  };
}
