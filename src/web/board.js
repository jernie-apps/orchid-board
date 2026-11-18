// Orchid Board client: collapse/expand, in-place navigation, live refresh over SSE.
// Plain script, no build step. The page works without it (links and the filter form navigate).
(() => {
  'use strict';
  const KEY = 'orchid.board.closed';
  const root = document.documentElement;
  root.classList.add('js');

  // The inbox page is server-rendered forms; it never swaps in the board fragment or listens to SSE.
  if (document.querySelector('[data-inbox]')) {
    inbox();
    return;
  }

  function inbox() {
    // All autosaves run one after another; page submits and navigation wait for them.
    let saving = Promise.resolve();
    const pending = new Map();
    const post = (url, body, status, fail) => {
      saving = saving.then(async () => {
        if (status) status.textContent = 'Saving…';
        try {
          const res = await fetch(url, { method: 'POST', body, credentials: 'same-origin', redirect: 'manual' });
          const ok = res.type === 'opaqueredirect' || res.ok;
          if (status) status.textContent = ok ? 'Saved' : fail;
        } catch {
          if (status) status.textContent = 'Not saved. Check your connection.';
        }
      });
      return saving;
    };
    const later = (key, fn, ms = 500) => {
      clearTimeout(pending.get(key)?.timer);
      pending.set(key, { fn, timer: setTimeout(() => { pending.delete(key); fn(); }, ms) });
    };
    const flush = () => {
      for (const [key, { fn, timer }] of pending) {
        clearTimeout(timer);
        pending.delete(key);
        fn();
      }
      return saving;
    };
    const fields = (form, skip) => {
      const body = new URLSearchParams();
      for (const [key, value] of new FormData(form)) if (typeof value === 'string' && !skip(key)) body.append(key, value);
      return body;
    };
    const go = href => void flush().then(() => { location.href = href; });

    const form = document.querySelector('form[data-proposal]');
    const row = key => form && [...form.querySelectorAll('.node[data-key]')].find(el => el.dataset.key === key);
    if (form) {
      const saved = form.querySelector('[data-saved]');
      const send = form.querySelector('[data-send]');
      const approve = form.querySelector('[data-approve]');

      const counts = () => {
        const ticked = new Set();
        for (const box of form.querySelectorAll('input[name="tick"]:checked')) ticked.add(box.closest('.node').dataset.i);
        for (const box of form.querySelectorAll('input[name="tick"]')) box.closest('.node').classList.toggle('ticked', box.checked);
        if (send) {
          send.textContent = ticked.size ? `Send back ${ticked.size}` : 'Send back';
          send.disabled = ticked.size === 0;
        }
        if (approve) {
          // Ticked items (and everything under them) are held back from this approval.
          let n = 0;
          for (const el of form.querySelectorAll('.node[data-ok]')) {
            const anc = el.dataset.anc ? el.dataset.anc.split(' ') : [];
            if (!ticked.has(el.dataset.i) && !anc.some(i => ticked.has(i))) n++;
          }
          // Approving with ticks creates the rest; ticked items stay drafts for review or send-back.
          approve.disabled = n === 0;
          approve.textContent = `Approve ${n} ${n === 1 ? 'issue' : 'issues'}`;
        }
        const tickBtn = document.querySelector('[data-tick]');
        const box = tickBtn && row(tickBtn.dataset.tick)?.querySelector('input[name="tick"]');
        if (box) tickBtn.textContent = box.checked ? 'Keep this item' : 'Send this back';
      };

      const saveTitles = () => {
        const body = fields(form, key => key === 'tick');
        body.set('op', 'save');
        return post(form.action, body, saved, 'Not saved. Check the titles.');
      };

      form.addEventListener('change', event => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (el.name === 'tick') counts();
        else if (el.name.startsWith('title:') && el.checkValidity()) saveTitles();
      });
      form.addEventListener('keydown', event => {
        const el = event.target;
        if (event.key === 'Enter' && el instanceof HTMLInputElement && el.name.startsWith('title:')) {
          event.preventDefault();
          el.blur();
        }
      });
      // Let pending autosaves land before a drop, approve, details or send-back submits the page.
      form.addEventListener('submit', event => {
        if (form.dataset.flushed) return;
        event.preventDefault();
        const submitter = event.submitter;
        void flush().then(() => {
          form.dataset.flushed = '1';
          form.requestSubmit(submitter instanceof HTMLButtonElement ? submitter : undefined);
        });
      });
      counts();

      // "Send this back" in the details pane ticks the row.
      document.addEventListener('click', event => {
        const button = event.target instanceof Element && event.target.closest('[data-tick]');
        const box = button && row(button.dataset.tick)?.querySelector('input[name="tick"]');
        if (!box) return;
        box.checked = !box.checked;
        counts();
      });
    }

    const details = document.querySelector('form[data-details]');
    if (details) {
      const status = details.querySelector('[data-dsaved]');
      const steps = details.querySelector('[data-steps]');
      const key = details.querySelector('input[name="key"]').value;
      const saveDetails = () => {
        const body = fields(details, name => name === 'op');
        body.set('op', 'details');
        return post(details.action, body, status, 'Not saved. Check the fields.');
      };
      // The row's "Comment" tag follows the draft comment as Por types.
      const tag = () => {
        const note = details.querySelector('textarea[name="note"]').value;
        const el = row(key)?.querySelector('[data-note-tag]');
        if (el) {
          el.hidden = note.trim() === '';
          el.title = note;
        }
      };
      const renumber = () => {
        steps.querySelectorAll('[data-step]').forEach((el, i) => {
          el.querySelector('input').setAttribute('aria-label', `Step ${i + 1}`);
          el.querySelector('button').setAttribute('aria-label', `Remove step ${i + 1}`);
          el.querySelector('button').value = `step-del:${i}`;
        });
      };
      details.addEventListener('input', event => {
        if (event.target.name === 'note') tag();
        later('details', saveDetails);
      });
      details.addEventListener('change', () => later('details', saveDetails, 0));
      details.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          later('details', saveDetails, 0);
        }
      });
      details.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const add = target && target.closest('[data-add-step]');
        const del = target && target.closest('[data-del-step]');
        if (add && steps) {
          event.preventDefault();
          const tpl = document.createElement('template');
          tpl.innerHTML = '<div class="step" data-step><input class="fld" name="step" maxlength="256"><button class="icon-b" type="submit" name="op" data-del-step>'
            + '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg></button></div>';
          const el = tpl.content.firstElementChild;
          el.querySelector('input').value = 'New step';
          steps.append(el);
          renumber();
          el.querySelector('input').select();
          later('details', saveDetails, 0);
        } else if (del) {
          event.preventDefault();
          const el = del.closest('[data-step]');
          const next = el.nextElementSibling || el.previousElementSibling;
          el.remove();
          renumber();
          (next ? next.querySelector('input') : details.querySelector('[data-add-step]')).focus();
          later('details', saveDetails, 0);
        }
      });
      details.addEventListener('submit', event => {
        event.preventDefault();
        later('details', saveDetails, 0);
      });
      // Closing the pane or picking another item waits for the last edit to save.
      for (const link of document.querySelectorAll('.ib-detail a[href]')) {
        link.addEventListener('click', event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          go(link.href);
        });
      }
      addEventListener('pagehide', () => void flush());
    }

    const dialog = document.querySelector('form[data-sendback]');
    if (dialog) {
      const confirm = dialog.querySelector('[data-confirm]');
      const proposal = dialog.action.replace(/\/send-back$/, '');
      const cancel = dialog.querySelector('.dlg-act a');
      const check = () => {
        const items = dialog.querySelectorAll('[data-item]');
        let missing = false;
        for (const item of items) {
          const empty = item.querySelector('textarea').value.trim() === '';
          if (empty) missing = true;
          if (!empty) item.querySelector('[data-warn]').hidden = true;
        }
        for (const count of dialog.querySelectorAll('[data-count]')) count.textContent = String(items.length);
        if (confirm) confirm.disabled = missing || items.length === 0;
      };
      // Comments typed here are drafts too: they survive a reload or a cancel and prefill the next send-back.
      const saveNotes = () => {
        const body = fields(dialog, name => name === 'key' || name === 'untick' || name === 'op');
        body.set('op', 'notes');
        return post(proposal, body, null, '');
      };
      dialog.addEventListener('input', () => {
        check();
        later('notes', saveNotes);
      });
      dialog.addEventListener('click', event => {
        const button = event.target instanceof Element && event.target.closest('button[name="untick"]');
        if (!button) return;
        event.preventDefault();
        button.closest('[data-item]').remove();
        if (!dialog.querySelector('[data-item]')) {
          go(cancel ? cancel.href : proposal);
          return;
        }
        check();
      });
      if (cancel) {
        cancel.addEventListener('click', event => {
          event.preventDefault();
          go(cancel.href);
        });
      }
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') go(cancel ? cancel.href : proposal);
      });
      dialog.addEventListener('submit', event => {
        if (dialog.dataset.flushed) return;
        event.preventDefault();
        const submitter = event.submitter;
        void flush().then(() => {
          dialog.dataset.flushed = '1';
          dialog.requestSubmit(submitter instanceof HTMLButtonElement ? submitter : undefined);
        });
      });
      const first = dialog.querySelector('textarea');
      if (first) first.focus();
      check();
    }

    // Approved proposals: refresh while the GitHub write runs, so created issues and errors show up.
    // Not while Por is editing withheld items: a reload would cut his typing.
    if (document.querySelector('[data-writing]') && !document.querySelector('form[data-proposal], form[data-details], form[data-sendback]')) {
      setTimeout(() => location.reload(), 5000);
    }
  }

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

  // A navigation (push given) is never aborted by a live refresh; the refresh runs after it lands.
  let loading = null;
  let refreshAfter = false;
  async function load(search, push) {
    if (loading) {
      if (loading.nav && push === undefined) {
        refreshAfter = true;
        return;
      }
      loading.ctrl.abort();
    }
    const job = { ctrl: new AbortController(), nav: push !== undefined };
    loading = job;
    try {
      await swap(search, push, job.ctrl.signal);
    } finally {
      if (loading === job) {
        loading = null;
        if (refreshAfter) {
          refreshAfter = false;
          void load(location.search);
        }
      }
    }
  }

  async function swap(search, push, signal) {
    let res;
    let html;
    try {
      res = await fetch(`/fragment${search}`, { credentials: 'same-origin', signal });
      if (res.status === 401) {
        location.href = '/login';
        return;
      }
      if (!res.ok) return;
      html = await res.text();
    } catch {
      return;
    }
    if (signal.aborted) return;
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
    let opened = false;
    // After a reconnect, changes sent while the stream was down are lost: re-fetch once.
    events.addEventListener('open', () => {
      if (opened) refresh();
      opened = true;
    });
    // A refused reconnect (e.g. 401 after a server restart) closes the stream for good.
    // Re-fetch so the fragment's 401 handler sends the user to /login.
    events.addEventListener('error', () => {
      if (events.readyState === EventSource.CLOSED) refresh();
    });
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
