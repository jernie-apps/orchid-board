// Orchid Board client: collapse/expand, in-place navigation, live refresh over SSE.
// Plain script, no build step. The page works without it (links and the filter form navigate).
(() => {
  'use strict';
  const KEY = 'orchid.board.closed';
  const root = document.documentElement;
  root.classList.add('js');

  let closed = new Set();
  try {
    closed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    closed = new Set();
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...closed]));
    } catch {
      // Storage blocked: collapse state lasts for this page only.
    }
  };

  const app = () => document.getElementById('app');

  // Status filters show every match, so collapse applies only to the unfiltered view.
  function applyCollapse() {
    const el = app();
    if (!el) return;
    const filtered = el.classList.contains('filtered');
    for (const row of el.querySelectorAll('.row[data-anc]')) {
      const anc = row.dataset.anc ? row.dataset.anc.split(' ') : [];
      row.hidden = !filtered && anc.some(ref => closed.has(ref));
    }
    for (const btn of el.querySelectorAll('[data-toggle]')) {
      const isClosed = !filtered && closed.has(btn.dataset.toggle);
      btn.classList.toggle('closed', isClosed);
      btn.setAttribute('aria-expanded', String(!isClosed));
      const label = btn.getAttribute('aria-label') || '';
      btn.setAttribute('aria-label', label.replace(/^(Collapse|Expand) /, isClosed ? 'Expand ' : 'Collapse '));
    }
  }

  function updateAges() {
    const now = Date.now();
    for (const t of document.querySelectorAll('time[data-ts]')) {
      const s = Math.max(0, Math.floor((now - Number(t.dataset.ts)) / 1000));
      const age = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
      t.textContent = s < 5 ? 'just now' : `${age} ago`;
    }
  }

  let loading = null;
  async function load(search, push) {
    const ctrl = new AbortController();
    if (loading) loading.abort();
    loading = ctrl;
    let res;
    try {
      res = await fetch(`/fragment${search}`, { credentials: 'same-origin', signal: ctrl.signal });
    } catch {
      return;
    }
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    if (!res.ok) return;
    const html = await res.text();
    if (ctrl.signal.aborted) return;
    loading = null;
    const focused = document.activeElement;
    const focusKey = focused && (focused.getAttribute('name') || focused.closest('.row')?.dataset.ref);
    const scroll = window.scrollY;
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const next = tpl.content.firstElementChild;
    const current = app();
    if (!next || !current) return;
    current.replaceWith(next);
    if (push !== undefined) history[push ? 'pushState' : 'replaceState'](null, '', search ? `/${search}` : '/');
    applyCollapse();
    updateAges();
    const phoneDetail = next.classList.contains('has-detail') && window.matchMedia('(max-width: 720px)').matches;
    window.scrollTo(0, push && phoneDetail ? 0 : scroll);
    if (focusKey) {
      const el = next.querySelector(`[name="${CSS.escape(focusKey)}"]`)
        || next.querySelector(`.row[data-ref="${CSS.escape(focusKey)}"] .open`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const toggle = target && target.closest('[data-toggle]');
    if (toggle) {
      const ref = toggle.dataset.toggle;
      if (closed.has(ref)) closed.delete(ref);
      else closed.add(ref);
      save();
      applyCollapse();
      return;
    }
    const link = target && target.closest('a[data-nav]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    void load(url.search, true);
  });

  document.addEventListener('change', event => {
    const form = event.target instanceof Element && event.target.closest('form[data-filters]');
    if (form) form.requestSubmit();
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-filters]')) return;
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (typeof value === 'string' && value !== '') params.set(key, value);
    const search = params.toString();
    void load(search ? `?${search}` : '', true);
  });

  window.addEventListener('popstate', () => void load(location.search));

  let pending = 0;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(() => void load(location.search), 250);
  };
  if ('EventSource' in window) {
    const events = new EventSource('/events');
    events.addEventListener('change', refresh);
    events.addEventListener('synced', event => {
      const span = document.querySelector('[data-synced]');
      const time = span && span.querySelector('time[data-ts]');
      if (time) {
        time.dataset.ts = event.data;
        updateAges();
      } else {
        refresh();
      }
    });
  }

  applyCollapse();
  updateAges();
  setInterval(updateAges, 5000);
})();
