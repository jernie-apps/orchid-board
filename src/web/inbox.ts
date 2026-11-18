import { issueApproveCode } from '../proposals/approve-code.ts';
import type { WriteStatus } from '../proposals/writer.ts';
import { approvalPlan, StoreError, type Feedback, type Proposal, type ProposalNode, type Store } from '../store/store.ts';
import { ago, badge, csrfField, escapeHtml as esc, LOGO, logoutForm, page, shortRepo, type Status } from './render.ts';

// Web inbox: Por reviews agent proposals, edits titles, drops nodes, approves or sends items back.
// Server-rendered and usable without JS; board.js adds autosave, live counts and the dialog checks.

/** What the inbox needs from the GitHub writer. */
export interface InboxWriter {
  kick(id: string): Promise<void>;
  status(id: string): WriteStatus;
}

export interface SendBackDraft {
  keys: string[];
  notes: Record<string, string>;
  note: string;
  /** Show "add a comment" hints on items without one. */
  check: boolean;
}

/** Per-request extras: a just-issued code, an error, ticks to keep, or the send-back dialog. */
export interface InboxState {
  code?: string;
  error?: string;
  ticked?: readonly string[];
  confirm?: SendBackDraft;
}

export interface InboxView extends InboxState {
  proposals: readonly Proposal[];
  selected: Proposal | null;
  dropped: readonly string[];
  feedback: readonly Feedback[];
  write: WriteStatus | null;
  csrf: string;
  now: number;
}

export type InboxOutcome =
  | { kind: 'redirect'; location: string }
  | { kind: 'render'; status: number; state: InboxState }
  | { kind: 'missing' };

export const REVIEWER = 'Por';
const MAX_NOTE = 4000;
const EARLIER = 20;
const LEVEL = { Phase: 'phase', Feature: 'feature', Task: 'task' } as const;

export function isProposalId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function proposalHref(id: string): string {
  return `/inbox/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------- POST handling

/** Apply a POST to `/inbox/<id>`. `op` picks the action; title edits are saved first for every op. */
export function applyProposalPost(store: Store, writer: InboxWriter | null, id: string, form: URLSearchParams, now: number): InboxOutcome {
  const proposal = store.getProposal(id);
  if (!proposal) return { kind: 'missing' };
  const op = form.get('op') ?? 'save';
  const ticked = unique(form.getAll('tick'));
  const back = { kind: 'redirect', location: proposalHref(id) } as const;
  try {
    if (op === 'code') return { kind: 'render', status: 200, state: { code: issueApproveCode(store, id, new Date(now)) } };
    if (proposal.state === 'pending') saveTitles(store, proposal, form, now);
    if (op === 'save') return back;
    if (op.startsWith('drop:')) {
      store.dropProposalNode(id, op.slice(5));
      return back;
    }
    if (op.startsWith('restore:')) {
      store.restoreProposalNode(id, op.slice(8));
      return back;
    }
    if (op === 'review') {
      if (ticked.length === 0) return { kind: 'render', status: 400, state: { error: 'Tick the items to send back first.' } };
      checkSendable(store, id, ticked);
      return { kind: 'render', status: 200, state: { ticked, confirm: { keys: ticked, notes: {}, note: '', check: false } } };
    }
    if (op === 'approve') {
      if (ticked.length > 0) {
        return { kind: 'render', status: 409, state: { ticked, error: 'Some items are ticked. Send them back or untick them before you approve.' } };
      }
      // Por approves in person: issue a code and consume it at once, the same path the MCP approve tool takes.
      store.transaction(() => {
        const at = new Date(now);
        const result = store.approveProposal(id, issueApproveCode(store, id, at), at);
        if (!result.ok) throw new StoreError('approval failed; try again');
      });
      if (writer) void writer.kick(id);
      return back;
    }
    return { kind: 'render', status: 400, state: { error: 'Unknown action.' } };
  } catch (error) {
    if (error instanceof StoreError) return { kind: 'render', status: 409, state: { ticked, error: sentence(error.message) } };
    throw error;
  }
}

/** Apply a POST to `/inbox/<id>/send-back`: the confirm dialog's submit or one of its "keep" buttons. */
export function applySendBack(store: Store, id: string, form: URLSearchParams, now: number): InboxOutcome {
  if (!store.getProposal(id)) return { kind: 'missing' };
  let keys = unique(form.getAll('key'));
  const notes: Record<string, string> = {};
  for (const key of keys) notes[key] = form.get(`note:${key}`) ?? '';
  const note = form.get('note') ?? '';
  const untick = form.get('untick');
  if (untick !== null) {
    keys = keys.filter(key => key !== untick);
    if (keys.length === 0) return { kind: 'redirect', location: proposalHref(id) };
    return { kind: 'render', status: 200, state: { ticked: keys, confirm: { keys, notes, note, check: false } } };
  }
  const draft = { keys, notes, note, check: true };
  try {
    if (keys.length === 0) return { kind: 'render', status: 400, state: { error: 'Tick the items to send back first.' } };
    checkSendable(store, id, keys);
    const missing = keys.some(key => notes[key]!.trim() === '');
    const long = keys.some(key => notes[key]!.length > MAX_NOTE) || note.length > MAX_NOTE;
    if (missing || long) {
      const error = missing ? 'Every item needs a comment.' : `Comments must be at most ${MAX_NOTE} characters.`;
      return { kind: 'render', status: 400, state: { ticked: keys, error, confirm: draft } };
    }
    const at = new Date(now);
    store.transaction(() => {
      for (const key of keys) store.sendBack(id, key, { author: REVIEWER, body: notes[key]!.trim() }, at);
      if (note.trim() !== '') store.addFeedback(id, null, REVIEWER, note.trim(), at);
    });
    return { kind: 'redirect', location: proposalHref(id) };
  } catch (error) {
    if (error instanceof StoreError) return { kind: 'render', status: 409, state: { ticked: keys, error: sentence(error.message), confirm: draft } };
    throw error;
  }
}

function saveTitles(store: Store, proposal: Proposal, form: URLSearchParams, now: number): void {
  const edits: [string, string][] = [];
  for (const [name, value] of form) {
    if (!name.startsWith('title:')) continue;
    const key = name.slice(6);
    const node = proposal.nodes.find(n => n.key === key);
    if (!node) throw new StoreError(`no node "${key}" in this proposal`);
    if (node.title !== value.trim()) edits.push([key, value]);
  }
  if (edits.length === 0) return;
  store.transaction(() => {
    for (const [key, title] of edits) store.renameProposalNode(proposal.id, key, title, new Date(now));
  });
}

/** Only live draft nodes can be sent back: not dropped, not already sent back, approved or created. */
function checkSendable(store: Store, id: string, keys: readonly string[]): void {
  const proposal = store.getProposal(id)!;
  if (proposal.state !== 'pending') throw new StoreError('only pending proposals can be sent back');
  const dropped = new Set(approvalPlan(proposal, store.droppedNodeKeys(id)).dropped);
  for (const key of keys) {
    const node = proposal.nodes.find(n => n.key === key);
    if (!node) throw new StoreError(`no node "${key}" in this proposal`);
    if (dropped.has(key)) throw new StoreError(`"${node.title}" is dropped`);
    if (node.status !== 'draft') throw new StoreError(`"${node.title}" is ${node.status.replace('_', ' ')}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ---------------------------------------------------------------- rendering

const X_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const DROP_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>';
const RESTORE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 7a4 4 0 1 0 1.2-2.8M3 2.5v2.7h2.7"/></svg>';

function agentName(proposal: Proposal): string {
  return proposal.agent ?? 'the agent';
}

export function proposalTitle(proposal: Proposal): string {
  const roots = proposal.nodes.filter(node => node.parentKey === null);
  const first = roots[0] ?? proposal.nodes[0];
  if (!first) return 'Empty proposal';
  const more = roots.length > 1 ? ` + ${roots.length - 1} more` : '';
  return `${first.type}: ${first.title}${more}`;
}

function reposOf(proposal: Proposal): string {
  return [...new Set(proposal.nodes.map(node => shortRepo(node.repo)))].join(', ');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sinceText(iso: string, now: number): string {
  const age = ago(Date.parse(iso), now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

function listMeta(proposal: Proposal, now: number): string {
  const age = sinceText(proposal.createdAt, now);
  if (proposal.state === 'pending') {
    return [agentName(proposal), reposOf(proposal), plural(proposal.nodes.length, 'issue'), age].join(' · ');
  }
  const created = proposal.nodes.filter(node => node.issueNumber !== null).length;
  const state = { approved: 'Approved · writing', done: 'Approved', rejected: 'Rejected', pending: '' }[proposal.state];
  return [state, plural(created, 'issue') + ' created', sinceText(proposal.updatedAt, now)].join(' · ');
}

function renderList(view: InboxView): string {
  const pending = view.proposals.filter(p => p.state === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const earlier = view.proposals.filter(p => p.state !== 'pending')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, EARLIER);
  const item = (p: Proposal) => {
    const on = view.selected?.id === p.id;
    return `<a class="prop${on ? ' on' : ''}${p.state === 'pending' ? ' pending' : ''}" href="${esc(proposalHref(p.id))}"${on ? ' aria-current="page"' : ''}>`
      + `<span class="prop-t">${esc(proposalTitle(p))}</span><span class="meta">${esc(listMeta(p, view.now))}</span></a>`;
  };
  return [
    '<nav class="ib-list" aria-label="Proposals">',
    `<div class="ib-sh">Waiting for you · ${pending.length}</div>`,
    pending.length ? pending.map(item).join('') : '<p class="meta ib-none">Nothing waiting.</p>',
    earlier.length ? `<div class="ib-sh">Earlier</div>${earlier.map(item).join('')}` : '',
    '</nav>',
  ].join('');
}

interface NodeRow {
  node: ProposalNode;
  index: number;
  depth: number;
  ancestors: number[];
}

function rowsOf(proposal: Proposal): NodeRow[] {
  const byKey = new Map<string, NodeRow>();
  return proposal.nodes.map((node, index) => {
    const parent = node.parentKey === null ? undefined : byKey.get(node.parentKey);
    const row = { node, index, depth: parent ? parent.depth + 1 : 0, ancestors: parent ? [...parent.ancestors, parent.index] : [] };
    byKey.set(node.key, row);
    return row;
  });
}

function nodeStatus(node: ProposalNode, dropped: boolean): Status | null {
  if (dropped) return { tone: 'idle', label: 'Dropped' };
  if (node.status === 'sent_back') return { tone: 'waiting', label: 'Sent back' };
  if (node.status === 'created') return { tone: 'done', label: `Created #${node.issueNumber}` };
  if (node.status === 'approved') return { tone: 'working', label: 'Queued' };
  return null;
}

function issueLink(node: ProposalNode): string {
  if (node.issueNumber === null) return '';
  const url = `https://github.com/${node.repo}/issues/${node.issueNumber}`;
  return `<a class="mono" href="${esc(url)}">${esc(shortRepo(node.repo))}#${node.issueNumber}</a>`;
}

function renderRows(view: InboxView, proposal: Proposal, editable: boolean): string {
  const direct = new Set(view.dropped);
  const plan = approvalPlan(proposal, direct);
  const dropped = new Set(plan.dropped);
  const approve = new Set(plan.approve);
  const ticked = new Set(view.ticked ?? []);
  const comments = new Map<string, string>();
  for (const item of view.feedback) if (item.nodeKey !== null) comments.set(item.nodeKey, item.body);
  return rowsOf(proposal).map(({ node, index, depth, ancestors }) => {
    const level = LEVEL[node.type];
    const isDropped = dropped.has(node.key);
    const live = editable && !isDropped && node.status === 'draft';
    const isTicked = live && ticked.has(node.key);
    const classes = ['node', `lvl-${level}`, `d${Math.min(depth, 2)}`, isTicked ? 'ticked' : '', isDropped ? 'dropped' : ''].filter(Boolean).join(' ');
    const tick = live
      ? `<input type="checkbox" class="cb" name="tick" value="${esc(node.key)}"${isTicked ? ' checked' : ''} aria-label="${esc(`Send back ${node.title}`)}">`
      : '<span class="cb-sp"></span>';
    const title = live
      ? `<input class="ti" name="title:${esc(node.key)}" value="${esc(node.title)}" maxlength="256" required aria-label="${esc(`Title of ${node.type.toLowerCase()} ${node.title}`)}">`
      : `<span class="ti ro">${esc(node.title)}</span>`;
    const status = nodeStatus(node, isDropped);
    const comment = comments.get(node.key);
    const tag = comment !== undefined && node.status === 'sent_back' ? `<span class="tag" title="${esc(comment)}">Comment</span>` : '';
    let action = '';
    if (editable && direct.has(node.key)) {
      action = `<button class="icon-b" type="submit" name="op" value="${esc(`restore:${node.key}`)}" aria-label="${esc(`Restore ${node.title}`)}">${RESTORE_ICON}</button>`;
    } else if (editable && !isDropped && (node.status === 'draft' || node.status === 'sent_back')) {
      action = `<button class="icon-b" type="submit" name="op" value="${esc(`drop:${node.key}`)}" aria-label="${esc(`Drop ${node.title}`)}">${DROP_ICON}</button>`;
    } else if (editable) {
      action = '<span class="icon-sp"></span>';
    }
    return [
      `<div class="${classes}" data-i="${index}" data-anc="${ancestors.join(' ')}"${approve.has(node.key) ? ' data-ok' : ''}>`,
      tick,
      `<span class="chip chip-${level}">${node.type}</span>`,
      title,
      node.branch ? `<span class="br">${esc(node.branch)}</span>` : '',
      '<span class="grow"></span>',
      status ? badge(status) : '',
      issueLink(node),
      tag,
      action,
      '</div>',
    ].join('');
  }).join('');
}

function summary(proposal: Proposal, dropped: ReadonlySet<string>): string {
  const live = proposal.nodes.filter(node => !dropped.has(node.key));
  const count = (type: ProposalNode['type'], one: string) => plural(live.filter(node => node.type === type).length, one);
  return [count('Phase', 'phase'), count('Feature', 'feature'), count('Task', 'task'), reposOf(proposal)].join(' · ');
}

function codeBox(view: InboxView, proposal: Proposal): string {
  if (proposal.state !== 'pending') return '';
  const action = esc(proposalHref(proposal.id));
  if (view.code) {
    return [
      '<div class="code-box" role="status">',
      `<div><div class="meta">Approve code</div><div class="code">${esc(view.code)}</div></div>`,
      `<div class="meta code-note">Tell ${esc(agentName(proposal))} this code in T3. Works once, expires in 15m. It won't be shown again.</div>`,
      '</div>',
    ].join('');
  }
  return [
    `<form class="code-box" method="post" action="${action}">`,
    csrfField(view.csrf),
    '<button class="btn" type="submit" name="op" value="code">Show approve code</button>',
    `<div class="meta code-note">For approving from T3: ${esc(agentName(proposal))} passes it to approve. Works once, expires in 15m.</div>`,
    '</form>',
  ].join('');
}

function intro(proposal: Proposal, now: number): string {
  const who = esc(agentName(proposal));
  const when = esc(sinceText(proposal.createdAt, now));
  const under = proposal.parent ? ` Attaches under <span class="mono">${esc(proposal.parent)}</span>.` : '';
  if (proposal.state === 'pending') {
    return `${who} proposed this from T3 ${when}.${under} Edit titles, drop what you don't want, then approve. Nothing exists in GitHub until you approve.`;
  }
  if (proposal.state === 'rejected') return `${who} proposed this ${when}. It was rejected.`;
  return `${who} proposed this ${when}.${under} Approved items are created in GitHub; sent-back items wait for ${who}.`;
}

function progress(view: InboxView, proposal: Proposal): string {
  if (proposal.state !== 'approved' && proposal.state !== 'done') return '';
  const queued = proposal.nodes.filter(node => node.status === 'approved' || node.status === 'created').length;
  const created = proposal.nodes.filter(node => node.status === 'created').length;
  const sent = proposal.nodes.filter(node => node.status === 'sent_back').length;
  const head = `Approved. ${proposal.state === 'done' ? 'Created' : 'Creating'} ${plural(queued, 'issue')} in GitHub.`
    + (sent ? ` ${sent} sent back to ${esc(agentName(proposal))}.` : '');
  const write = view.write;
  let status: Status;
  if (proposal.state === 'done') status = { tone: 'done', label: `${created} of ${queued} created` };
  else if (write?.error) status = { tone: 'failed', label: 'Write failed' };
  else if (write?.running) status = { tone: 'working', label: `Writing · ${created} of ${queued}` };
  else status = { tone: 'waiting', label: `Queued · ${created} of ${queued}` };
  const lines: string[] = [];
  if (proposal.state === 'approved' && write?.error) {
    lines.push(`<p class="prog-err">${esc(write.error)}</p>`);
    if (write.retryAt) lines.push(`<p class="meta">Retries automatically at <time datetime="${esc(write.retryAt)}">${esc(write.retryAt.slice(11, 16))} UTC</time>.</p>`);
  }
  for (const warning of write?.warnings ?? []) lines.push(`<p class="meta">${esc(warning)}</p>`);
  return [
    `<div class="prog"${proposal.state === 'approved' ? ' data-writing' : ''} role="status">`,
    `<div class="prog-line">${badge(status)}<span>${head}</span></div>`,
    lines.join(''),
    '</div>',
  ].join('');
}

function renderDialog(view: InboxView, proposal: Proposal): string {
  const draft = view.confirm;
  if (!draft) return '';
  const who = esc(agentName(proposal));
  const byKey = new Map(proposal.nodes.map(node => [node.key, node]));
  const items = draft.keys.flatMap(key => {
    const node = byKey.get(key);
    if (!node) return [];
    const note = draft.notes[key] ?? '';
    const missing = draft.check && note.trim() === '';
    return [[
      '<div class="sb-item" data-item>',
      `<input type="hidden" name="key" value="${esc(key)}">`,
      `<div class="sb-line"><span class="chip chip-${LEVEL[node.type]}">${node.type}</span><strong>${esc(node.title)}</strong>`,
      `<button class="icon-b" type="submit" name="untick" value="${esc(key)}" formnovalidate aria-label="${esc(`Keep ${node.title}`)}">${X_ICON}</button></div>`,
      `<textarea class="fld" name="note:${esc(key)}" rows="2" required maxlength="${MAX_NOTE}" placeholder="What should change in this item?" aria-label="${esc(`Comment for ${node.title}`)}">${esc(note)}</textarea>`,
      `<span class="warn"${missing ? '' : ' hidden'} data-warn>Add a comment so ${who} knows what to fix.</span>`,
      '</div>',
    ].join('')];
  });
  const count = draft.keys.length;
  return [
    '<div class="scrim">',
    '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="sb-title">',
    `<form method="post" action="${esc(proposalHref(proposal.id))}/send-back" data-sendback>`,
    csrfField(view.csrf),
    `<h3 id="sb-title">Send <span data-count>${count}</span> back to ${who}?</h3>`,
    `<p class="meta">Each item gets its own comment. They stay drafts; ${who} reads them with get_feedback and resubmits only these. The rest is created when you approve.</p>`,
    view.error ? `<p class="ib-msg err" role="alert">${esc(view.error)}</p>` : '',
    items.join(''),
    '<label for="sb-all" class="meta">Note for the whole proposal (optional)</label>',
    `<textarea id="sb-all" class="fld" name="note" rows="2" maxlength="${MAX_NOTE}" placeholder="Applies to every item sent back">${esc(draft.note)}</textarea>`,
    '<div class="dlg-act">',
    `<a class="btn" href="${esc(proposalHref(proposal.id))}">Cancel</a>`,
    `<button class="btn primary" type="submit" name="op" value="send" data-confirm>Send back <span data-count>${count}</span></button>`,
    '</div>',
    '</form>',
    '</div>',
    '</div>',
  ].join('');
}

function renderProposal(view: InboxView, proposal: Proposal): string {
  const editable = proposal.state === 'pending';
  const plan = approvalPlan(proposal, view.dropped);
  const dropped = new Set(plan.dropped);
  const action = esc(proposalHref(proposal.id));
  const approveCount = plan.approve.length;
  const head = [
    '<div class="ib-head">',
    `<div class="ib-intro"><h2>${esc(proposalTitle(proposal))}</h2><p class="meta">${intro(proposal, view.now)}</p></div>`,
    codeBox(view, proposal),
    '</div>',
  ].join('');
  const error = view.error && !view.confirm ? `<p class="ib-msg err" role="alert">${esc(view.error)}</p>` : '';
  const hint = editable
    ? 'Edit titles inline. Drop what you don\'t want. Tick items to send them back.'
    : '';
  const bar = [
    '<div class="ib-bar">',
    `<span class="meta">${esc(summary(proposal, dropped))}</span>`,
    '<span class="grow"></span>',
    hint ? `<span class="meta ib-hint">${hint}</span>` : '',
    editable ? '<span class="meta" data-saved aria-live="polite"></span>' : '',
    // First submit button in the form, so Enter in a title saves instead of hitting a row's drop button.
    editable ? '<button class="btn save" type="submit" name="op" value="save">Save titles</button>' : '',
    '</div>',
  ].join('');
  const rows = `<div class="nodes">${renderRows(view, proposal, editable)}</div>`;
  if (!editable) {
    return `<section class="ib-main" aria-label="Proposal">${head}${progress(view, proposal)}${error}${bar}${rows}</section>`;
  }
  const foot = [
    '<div class="ib-foot">',
    '<span class="meta">Branches follow feature/&lt;feature&gt;/&lt;task&gt;. Phase gets no branch.</span>',
    '<span class="grow"></span>',
    '<button class="btn" type="submit" name="op" value="review" data-send>Send back</button>',
    `<button class="btn primary" type="submit" name="op" value="approve" data-approve${approveCount ? '' : ' disabled'}>Approve ${plural(approveCount, 'issue')}</button>`,
    '</div>',
  ].join('');
  return [
    `<section class="ib-main" aria-label="Proposal">${head}${error}`,
    `<form class="ib-form" method="post" action="${action}" data-proposal>`,
    csrfField(view.csrf),
    bar, rows, foot,
    '</form>',
    '</section>',
  ].join('');
}

export function renderInbox(view: InboxView): string {
  const selected = view.selected;
  const main = selected
    ? renderProposal(view, selected)
    : '<section class="ib-main ib-empty" aria-label="Proposal"><p class="meta">Nothing to review. Agents send proposals from T3 with propose_tree.</p></section>';
  const body = [
    `<div id="inbox" class="app inbox${view.confirm ? ' has-dialog' : ''}" data-inbox>`,
    '<header class="top">',
    `<a class="brand" href="/">${LOGO}<span class="brand-name">Orchid Board</span></a>`,
    '<span class="meta" aria-hidden="true">/</span><h1 class="ib-title">Inbox</h1>',
    '<span class="grow"></span>',
    logoutForm(view.csrf),
    '</header>',
    '<div class="ib-panes">',
    renderList(view),
    main,
    '</div>',
    selected ? renderDialog(view, selected) : '',
    '</div>',
  ].join('\n');
  return page(body, true, 'Inbox · Orchid Board');
}
