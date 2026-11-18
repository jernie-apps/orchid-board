import { isRef } from '../store/ref.ts';
import type { ChecksRollup, Pr, Tree, TreeNode } from '../store/store.ts';

/** Badge tone. Each tone has its own glyph in board.css, so status never relies on color alone. */
export type Tone = 'done' | 'failed' | 'working' | 'waiting' | 'idle';
export type StatusFilter = 'all' | 'working' | 'needs' | 'failed';

export interface Status {
  tone: Tone;
  label: string;
}

/** Board filters and selection, kept in the URL query. */
export interface BoardQuery {
  /** `owner/name`, exactly as the store holds it. */
  repo: string | null;
  /** Iteration title. */
  sprint: string | null;
  status: StatusFilter;
  /** Selected issue ref for the details pane. */
  sel: string | null;
}

export interface BoardView {
  /** Tree already filtered by repo and sprint; the status filter is applied while rendering. */
  tree: Tree;
  /** Distinct repos and sprint titles in the store, for the filter menus. */
  repos: readonly string[];
  sprints: readonly string[];
  issueCount: number;
  /** Epoch ms of the poller's last successful poll, or null. */
  lastSyncAt: number | null;
  mcpPort: number;
  now: number;
}

const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'working', 'needs', 'failed'];
const FILTER_TONE: Record<Exclude<StatusFilter, 'all'>, Tone> = { working: 'working', needs: 'waiting', failed: 'failed' };
const LEVEL = { Phase: 'phase', Feature: 'feature', Task: 'task' } as const;

/** Parse filters from a query string. Unknown or malformed values fall back to "no filter". */
export function parseQuery(params: URLSearchParams): BoardQuery {
  const text = (key: string, max: number): string | null => {
    const value = params.get(key)?.trim() ?? '';
    return value === '' || value.length > max ? null : value;
  };
  const repo = text('repo', 200);
  const status = params.get('status');
  const sel = text('sel', 300);
  return {
    repo: repo !== null && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo) ? repo : null,
    sprint: text('sprint', 200),
    status: STATUS_FILTERS.includes(status as StatusFilter) ? (status as StatusFilter) : 'all',
    sel: sel !== null && isRef(sel) ? sel : null,
  };
}

/** Relative link to the board with `patch` applied. Default values are left out of the URL. */
export function boardHref(query: BoardQuery, patch: Partial<BoardQuery> = {}): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.repo) params.set('repo', next.repo);
  if (next.sprint) params.set('sprint', next.sprint);
  if (next.status !== 'all') params.set('status', next.status);
  if (next.sel) params.set('sel', next.sel);
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}
const esc = escapeHtml;

/** Only GitHub https links reach an href; anything else (e.g. `javascript:`) is dropped. */
function githubUrl(url: string): string | null {
  return /^https:\/\/github\.com\/[^\s"'<>]*$/.test(url) ? url : null;
}

/** Branch slug: the title's leading `name:` prefix if present, else the slugified title. */
export function slugOf(title: string): string {
  const prefix = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*:/.exec(title);
  if (prefix) return prefix[1]!.toLowerCase();
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

/** Feature: `feature/<f>/<f>`. Task: `feature/<f>/<task>` under its nearest Feature. Phase: none. */
export function branchOf(node: TreeNode, feature: TreeNode | null): string | null {
  if (node.type === 'Feature') return `feature/${slugOf(node.title)}/${slugOf(node.title)}`;
  if (node.type === 'Task' && feature) return `feature/${slugOf(feature.title)}/${slugOf(node.title)}`;
  return null;
}

/** The PR to show: newest open, else newest merged, else newest closed. */
export function primaryPr(prs: readonly Pr[]): Pr | null {
  const order = { open: 0, merged: 1, closed: 2 } as const;
  return [...prs].sort((a, b) => order[a.state] - order[b.state] || b.number - a.number)[0] ?? null;
}

/**
 * Task status, first match wins:
 * 1. issue closed → Done
 * 2. an open PR's CI rollup is fail → Failed (merged or closed PRs never count)
 * 3. active claim → Working
 * 4. an open, non-draft PR with CI pass → Needs you (ready for Por's review)
 * 5. otherwise → Open
 */
export function taskStatus(node: TreeNode): Status {
  if (node.state === 'closed') return { tone: 'done', label: 'Done' };
  const open = node.prs.filter(pr => pr.state === 'open');
  if (open.some(pr => pr.checks === 'fail')) return { tone: 'failed', label: 'CI failed' };
  if (node.claim) return { tone: 'working', label: 'Working' };
  if (open.some(pr => !pr.draft && pr.checks === 'pass')) return { tone: 'waiting', label: 'Needs you' };
  return { tone: 'idle', label: 'Open' };
}

/** Every Task under a node (the node itself if it is one). */
function tasksOf(node: TreeNode): TreeNode[] {
  if (node.type === 'Task') return [node];
  return node.children.flatMap(tasksOf);
}

/** Feature / Phase status: a rollup of the Tasks below it. */
export function rollupStatus(node: TreeNode): Status {
  const tasks = tasksOf(node).map(taskStatus);
  if (tasks.length === 0) return node.state === 'closed' ? { tone: 'done', label: 'Done' } : { tone: 'idle', label: 'No tasks' };
  const count = (tone: Tone) => tasks.filter(t => t.tone === tone).length;
  if (count('failed')) return { tone: 'failed', label: `${count('failed')} failing` };
  if (count('waiting')) return { tone: 'waiting', label: 'Needs you' };
  const done = count('done');
  const label = `${done} of ${tasks.length} done`;
  if (done === tasks.length) return { tone: 'done', label };
  return { tone: count('working') ? 'working' : 'idle', label };
}

export function statusOf(node: TreeNode): Status {
  return node.type === 'Task' ? taskStatus(node) : rollupStatus(node);
}

const CI: Record<Exclude<ChecksRollup, 'none'>, Status> = {
  pass: { tone: 'done', label: 'Pass' },
  fail: { tone: 'failed', label: 'Failed' },
  running: { tone: 'working', label: 'Running' },
};

/** Compact age: `now`, `45s`, `14m`, `3h`, `2d`. */
export function ago(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function sinceText(fromMs: number, nowMs: number): string {
  const age = ago(fromMs, nowMs);
  return age === 'now' ? 'just now' : `${age} ago`;
}

function badge(status: Status): string {
  return `<span class="badge st-${status.tone}"><span class="g" aria-hidden="true"></span>${esc(status.label)}</span>`;
}

function chip(node: TreeNode): string {
  const level = node.type ? LEVEL[node.type] : 'issue';
  return `<span class="chip chip-${level}">${esc(node.type ?? 'Issue')}</span>`;
}

function shortRepo(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1);
}

function prLabel(pr: Pr, issueRepo: string): string {
  return pr.repo === issueRepo ? `#${pr.number}` : `${shortRepo(pr.repo)}#${pr.number}`;
}

function prState(pr: Pr): string {
  return pr.state === 'open' && pr.draft ? 'draft' : pr.state;
}

function prLink(pr: Pr, issueRepo: string): string {
  const url = githubUrl(pr.url);
  const text = esc(prLabel(pr, issueRepo));
  return url ? `<a class="mono pr" href="${esc(url)}" title="${esc(pr.title)}">${text}</a>` : `<span class="mono">${text}</span>`;
}

function issueUrl(node: TreeNode): string {
  return `https://github.com/${node.repo}/issues/${node.number}`;
}

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
const CLOSE = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const BACK = '<svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3l-7 7 7 7"/></svg>';
const REPO = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2.5" width="10" height="9" rx="2"/><path d="M2 5.5h10"/></svg>';
export const LOGO = '<span class="logo" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="2"/><path d="M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3"/></svg></span>';

interface Row {
  node: TreeNode;
  depth: number;
  ancestors: string[];
  feature: TreeNode | null;
}

interface Group {
  repo: string;
  nodes: TreeNode[];
}

/** Roots and orphans grouped by repo. Typeless orphans show only when they carry children. */
function groupsOf(tree: Tree): Group[] {
  const groups = new Map<string, Group>();
  for (const node of [...tree.roots, ...tree.orphans]) {
    if (node.type === null && node.children.length === 0) continue;
    const group = groups.get(node.repo) ?? { repo: node.repo, nodes: [] };
    group.nodes.push(node);
    groups.set(node.repo, group);
  }
  for (const group of groups.values()) group.nodes.sort((a, b) => a.number - b.number);
  return [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** True when the node, or a Task below it, passes the status filter. */
function keep(node: TreeNode, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (node.type === 'Task') return taskStatus(node).tone === FILTER_TONE[filter];
  return node.children.some(child => keep(child, filter));
}

function flatten(nodes: readonly TreeNode[], filter: StatusFilter): Row[] {
  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number, ancestors: string[], feature: TreeNode | null) => {
    if (!keep(node, filter)) return;
    rows.push({ node, depth, ancestors, feature });
    const next = node.type === 'Feature' ? node : feature;
    for (const child of node.children) walk(child, depth + 1, [...ancestors, node.ref], next);
  };
  for (const node of nodes) walk(node, 0, [], null);
  return rows;
}

function findNode(nodes: readonly TreeNode[], ref: string): { node: TreeNode; feature: TreeNode | null; parent: TreeNode | null } | null {
  const walk = (list: readonly TreeNode[], feature: TreeNode | null, parent: TreeNode | null): ReturnType<typeof findNode> => {
    for (const node of list) {
      if (node.ref === ref) return { node, feature, parent };
      const found = walk(node.children, node.type === 'Feature' ? node : feature, node);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes, null, null);
}

function renderRow(row: Row, query: BoardQuery, now: number): string {
  const { node, depth } = row;
  const level = node.type ? LEVEL[node.type] : 'issue';
  const selected = query.sel === node.ref;
  const hasKids = node.children.length > 0;
  const label = `#${node.number} ${node.title}`;
  const toggle = hasKids
    ? `<button class="chev" type="button" data-toggle="${esc(node.ref)}" aria-expanded="true" aria-label="${esc(`Collapse ${label}`)}">${CHEVRON}</button>`
    : '<span class="sp"></span>';
  const branch = branchOf(node, row.feature);
  const pr = primaryPr(node.prs);
  let agent = '';
  if (node.claim) {
    const since = ago(Date.parse(node.claim.since), now);
    agent = `<span class="agent"><span class="av" aria-hidden="true">${esc(node.claim.agent.slice(0, 1).toUpperCase())}</span>${esc(node.claim.agent)} <span class="mono" title="claimed ${esc(node.claim.since)}">${esc(since)}</span></span>`;
  } else if (node.type === 'Task' && node.state === 'open') {
    agent = `<span class="meta">${taskStatus(node).tone === 'waiting' ? 'Review PR' : 'Unclaimed'}</span>`;
  }
  const ci = pr && pr.checks !== 'none' ? `<span class="ci-l">CI</span>${badge(CI[pr.checks])}` : '';
  return [
    `<div class="row lvl-${level}${selected ? ' sel' : ''}" data-ref="${esc(node.ref)}" data-anc="${esc(row.ancestors.join(' '))}">`,
    `<div class="c-item ind${Math.min(depth, 2)}">${toggle}${chip(node)}`,
    `<a class="open" href="${esc(boardHref(query, { sel: node.ref }))}" data-nav${selected ? ' aria-current="true"' : ''} aria-label="${esc(`Show details for ${label}`)}"><span class="num">#${node.number}</span><span class="ttl">${esc(node.title)}</span></a>`,
    branch ? `<span class="br">${esc(branch)}</span>` : '',
    '</div>',
    `<div class="c-status">${badge(statusOf(node))}</div>`,
    '<span class="brk"></span>',
    `<div class="c-agent">${agent}</div>`,
    `<div class="c-pr">${pr ? `${prLink(pr, node.repo)} <span class="meta">${esc(prState(pr))}</span>` : ''}</div>`,
    `<div class="c-ci">${ci}</div>`,
    `<div class="c-sprint meta">${esc(node.iteration?.title ?? '')}</div>`,
    '</div>',
  ].join('');
}

function groupSummary(group: Group): string {
  const tasks = group.nodes.flatMap(tasksOf);
  const done = tasks.filter(t => taskStatus(t).tone === 'done').length;
  const summary = tasks.length ? `${done} of ${tasks.length} tasks done` : 'No tasks';
  return group.nodes.some(n => n.type === 'Phase') ? summary : `No phase yet · ${summary}`;
}

function renderTree(view: BoardView, query: BoardQuery): string {
  const out: string[] = [];
  for (const group of groupsOf(view.tree)) {
    const rows = flatten(group.nodes, query.status);
    if (rows.length === 0) continue;
    out.push(`<div class="grp">${REPO}<span class="grp-name" title="${esc(group.repo)}">${esc(shortRepo(group.repo))}</span><span class="meta">${esc(groupSummary(group))}</span></div>`);
    for (const row of rows) out.push(renderRow(row, query, view.now));
  }
  if (out.length === 0) {
    const text = view.issueCount === 0 ? 'No issues synced yet.' : 'Nothing matches these filters.';
    return `<p class="empty">${text}</p>`;
  }
  return out.join('\n');
}

function allTasks(tree: Tree): TreeNode[] {
  return [...tree.roots, ...tree.orphans].flatMap(tasksOf);
}

function renderBanner(tasks: readonly TreeNode[]): string {
  const needs = tasks.filter(t => taskStatus(t).tone === 'waiting');
  if (needs.length === 0) return '';
  const parts = needs.slice(0, 3).map(t => {
    const pr = t.prs.find(p => p.state === 'open' && !p.draft && p.checks === 'pass');
    return pr ? `PR ${prLabel(pr, t.repo)} ready for review on #${t.number}.` : `#${t.number} waits on you.`;
  });
  if (needs.length > 3) parts.push(`And ${needs.length - 3} more.`);
  const head = needs.length === 1 ? '1 needs you.' : `${needs.length} need you.`;
  return `<div class="banner" role="status"><span class="badge st-waiting bare"><span class="g" aria-hidden="true"></span></span><span><strong>${head}</strong> ${esc(parts.join(' '))}</span></div>`;
}

function renderHeader(view: BoardView, query: BoardQuery, tasks: readonly TreeNode[]): string {
  const option = (value: string, text: string, selected: boolean) =>
    `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;
  const repos = [option('', 'All repos', query.repo === null), ...view.repos.map(r => option(r, shortRepo(r), r === query.repo))];
  const sprints = [option('', 'All sprints', query.sprint === null), ...view.sprints.map(s => option(s, s, s === query.sprint))];
  const count = (filter: Exclude<StatusFilter, 'all'>) => tasks.filter(t => taskStatus(t).tone === FILTER_TONE[filter]).length;
  const seg = (filter: StatusFilter, text: string) => {
    const on = query.status === filter;
    return `<a class="seg-b${on ? ' on' : ''}" href="${esc(boardHref(query, { status: filter, sel: null }))}" data-nav${on ? ' aria-current="true"' : ''}>${esc(text)}</a>`;
  };
  return [
    '<header class="top">',
    `<div class="brand">${LOGO}<h1>Orchid Board</h1></div>`,
    '<form class="filters" method="get" action="/" data-filters>',
    query.status !== 'all' ? `<input type="hidden" name="status" value="${esc(query.status)}">` : '',
    `<label class="pick">Repo <select name="repo" aria-label="Repo">${repos.join('')}</select></label>`,
    `<label class="pick">Sprint <select name="sprint" aria-label="Sprint">${sprints.join('')}</select></label>`,
    '<button class="btn apply" type="submit">Apply</button>',
    '</form>',
    '<nav class="seg" aria-label="Status">',
    seg('all', 'All'), seg('working', `Working ${count('working')}`), seg('needs', `Needs you ${count('needs')}`), seg('failed', `Failed ${count('failed')}`),
    '</nav>',
    '<span class="grow"></span>',
    '<form method="post" action="/logout"><button class="btn" type="submit">Log out</button></form>',
    '</header>',
  ].join('');
}

function renderDetail(view: BoardView, query: BoardQuery): string {
  if (!query.sel) return '';
  const found = findNode([...view.tree.roots, ...view.tree.orphans], query.sel);
  if (!found) return '';
  const { node, feature, parent } = found;
  const status = statusOf(node);
  const branch = branchOf(node, feature);
  const close = esc(boardHref(query, { sel: null }));
  const github = esc(issueUrl(node));
  const kids = node.children.map(kid =>
    `<div class="chk"><a href="${esc(boardHref(query, { sel: kid.ref }))}" data-nav><span class="num">#${kid.number}</span> ${esc(kid.title)}</a>${badge(statusOf(kid))}</div>`);
  const kidsLabel = node.type === 'Phase' ? 'Features' : node.type === 'Feature' ? 'Tasks' : 'Children';
  const pr = primaryPr(node.prs);
  const prs = [...node.prs].sort((a, b) => b.number - a.number)
    .map(p => `${prLink(p, node.repo)} <span class="meta">${esc(prState(p))}</span>`).join(', ');
  const agent = node.claim
    ? `${esc(node.claim.agent)} · claimed ${sinceText(Date.parse(node.claim.since), view.now)}`
    : node.type === 'Task' ? 'Unclaimed' : 'None';
  const parentLine = node.parent
    ? parent ? `<a href="${esc(boardHref(query, { sel: parent.ref }))}" data-nav>#${parent.number} ${esc(parent.title)}</a>` : esc(node.parent)
    : 'None';
  return [
    `<aside class="detail" aria-label="Issue details">`,
    `<div class="d-bar"><a class="back" href="${close}" data-nav>${BACK}Board</a><span class="grow"></span><a class="gh" href="${github}">GitHub</a></div>`,
    '<div class="d-head">',
    `<div class="d-line">${chip(node)}<span class="num">${esc(shortRepo(node.repo))} #${node.number}</span><span class="grow"></span><a class="d-gh" href="${github}">Open in GitHub</a><a class="chev" href="${close}" data-nav aria-label="Close details">${CLOSE}</a></div>`,
    `<h2>${esc(node.title)}</h2>`,
    `<div class="d-line wrap">${badge(status)}${branch ? `<span class="br">${esc(branch)}</span>` : ''}</div>`,
    '</div>',
    kids.length ? `<div class="sec"><div class="sh">${kidsLabel} · ${kids.length}</div>${kids.join('')}</div>` : '',
    '<div class="sec"><div class="sh">Work</div><dl class="kv">',
    `<dt>Agent</dt><dd>${agent}</dd>`,
    `<dt>Pull request</dt><dd>${prs || 'None yet'}</dd>`,
    `<dt>CI</dt><dd>${pr && pr.checks !== 'none' ? badge(CI[pr.checks]) : 'None'}</dd>`,
    `<dt>Sprint</dt><dd>${esc(node.iteration?.title ?? 'None')}</dd>`,
    `<dt>Parent</dt><dd>${parentLine}</dd>`,
    '</dl></div>',
    `<div class="sec last"><p class="meta">Description, steps and activity live on <a href="${github}">GitHub</a>.</p></div>`,
    '</aside>',
  ].join('');
}

function renderFooter(view: BoardView): string {
  const synced = view.lastSyncAt === null
    ? '<span class="dot idle"></span>Not synced yet'
    : `<span class="dot ok"></span>Synced <time data-ts="${view.lastSyncAt}" datetime="${new Date(view.lastSyncAt).toISOString()}">${sinceText(view.lastSyncAt, view.now)}</time> from GitHub`;
  const repos = `${view.repos.length} ${view.repos.length === 1 ? 'repo' : 'repos'}`;
  const issues = `${view.issueCount} ${view.issueCount === 1 ? 'issue' : 'issues'}`;
  return [
    '<footer class="status">',
    `<span class="mono" data-synced>${synced}</span>`,
    `<span class="mono">${repos} · ${issues}</span>`,
    `<span class="mono">MCP 127.0.0.1:${view.mcpPort}</span>`,
    '</footer>',
  ].join('');
}

/** The live part of the page. `/fragment` returns exactly this; board.js swaps it in on SSE changes. */
export function renderApp(view: BoardView, query: BoardQuery): string {
  const tasks = allTasks(view.tree);
  const detail = renderDetail(view, query);
  const classes = ['app', detail ? 'has-detail' : '', query.status !== 'all' ? 'filtered' : ''].filter(Boolean).join(' ');
  return [
    `<div id="app" class="${classes}">`,
    renderHeader(view, query, tasks),
    renderBanner(tasks),
    '<div class="panes">',
    '<main class="board"><div class="grid">',
    '<div class="row head" aria-hidden="true"><span>Item</span><span>Status</span><span>Agent</span><span>Pull request</span><span>CI</span><span>Sprint</span></div>',
    renderTree(view, query),
    '</div></main>',
    detail,
    '</div>',
    renderFooter(view),
    '</div>',
  ].join('\n');
}

function page(body: string, script: boolean): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Orchid Board</title>',
    '<link rel="stylesheet" href="/board.css">',
    script ? '<script src="/board.js" defer></script>' : '',
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].filter(Boolean).join('\n');
}

export function renderPage(view: BoardView, query: BoardQuery): string {
  return page(renderApp(view, query), true);
}

export function renderLogin(error: string | null = null): string {
  return page([
    '<main class="login">',
    '<form class="login-card" method="post" action="/login">',
    `<div class="brand">${LOGO}<h1>Orchid Board</h1></div>`,
    '<label for="passphrase">Passphrase</label>',
    '<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>',
    error ? `<p class="err" role="alert">${esc(error)}</p>` : '',
    '<button class="btn primary" type="submit">Sign in</button>',
    '</form>',
    '</main>',
  ].join(''), false);
}
