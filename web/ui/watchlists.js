/* Custom watchlists - the ☆ button next to every stock symbol, its "add to watchlist"
   popover, and saving (this browser's localStorage, key sb:watchlists; other open tabs
   follow along). The data rules live in web/lib/watchlists.js (SB.wlModel); the
   "My Watchlists" page is web/pages/lists.js; keeping the lists in the owner's Google
   Sheet (the same lists on every device) is web/ui/watchlist-sync.js.

   SB.watchlists = { state(), get(id), create(name), rename(id, name), remove(id), add(id, sym),
                     addMany(id, text), removeSym(id, sym), toggle(id, sym), select(id), has(sym),
                     listsWith(sym), onChange(fn(state, origin)) -> off(), saved(), open(sym, anchor),
                     replace(state) }
   origin: 'local' (a change made here), 'tab' (another tab of this site), 'sync' (replace: the sheet's lists)
   SB.wlStar(sym) -> the star button's HTML (used by ui.stockCell, the stock drawer, cards) */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, M = SB.wlModel;
  var KEY = 'watchlists';

  var state = M.load(ui.store.get(KEY, null));
  var saveOk = true;
  var listeners = [];

  function persist() {
    saveOk = ui.store.set(KEY, state);
    return saveOk;
  }
  function tell(origin) {
    listeners.slice().forEach(function (fn) { try { fn(state, origin); } catch (e) { if (window.console) console.error(e); } });
  }
  function changed(origin) {
    persist();
    refreshStars();
    tell(origin);
  }
  /** Apply a model result: { state } / { error } / a bare state. */
  function apply(r) {
    if (r && r.error) return r;
    var next = r && r.lists ? r : r && r.state;
    if (next && next !== state) { state = next; changed('local'); }
    return r;
  }

  // ---------- the star ----------
  function starHtml(sym) {
    var x = M.normSym(sym);
    if (!M.validSym(x)) return '';
    var n = M.listsWith(state, x).length;
    return '<button type="button" class="wl-star' + (n ? ' on' : '') + '" data-wl="' + esc(x) + '" aria-haspopup="dialog" aria-label="' +
      esc(n ? x + ' is in ' + n + ' watchlist' + (n === 1 ? '' : 's') + ' - change' : 'Add ' + x + ' to a watchlist') + '" title="' +
      esc(n ? 'In: ' + M.listsWith(state, x).map(function (l) { return l.name; }).join(', ') : 'Add to a watchlist') + '">' + (n ? '★' : '☆') + '</button>';
  }
  function refreshStars() {
    document.querySelectorAll('.wl-star[data-wl]').forEach(function (b) {
      var x = b.getAttribute('data-wl'), lists = M.listsWith(state, x), n = lists.length;
      b.classList.toggle('on', n > 0);
      b.textContent = n ? '★' : '☆';
      b.setAttribute('aria-label', n ? x + ' is in ' + n + ' watchlist' + (n === 1 ? '' : 's') + ' - change' : 'Add ' + x + ' to a watchlist');
      b.title = n ? 'In: ' + lists.map(function (l) { return l.name; }).join(', ') : 'Add to a watchlist';
    });
  }

  // ---------- the popover ----------
  var pop = null, popSym = null, popAnchor = null, popFilter = '';
  function closePop(back) {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (back && popAnchor && popAnchor.isConnected) popAnchor.focus();
    popAnchor = null; popSym = null; popFilter = '';
  }
  function popBody(msg, msgCls) {
    var x = popSym, lists = M.sort(state.lists, 'name');
    var shown = popFilter ? lists.filter(function (l) { return l.name.toLowerCase().indexOf(popFilter.toLowerCase()) >= 0; }) : lists;
    var h = '<div class="wl-pop-h"><b>' + esc(x) + '</b><span class="sub">' + (lists.length ? 'tick the watchlists it belongs to' : 'make your first watchlist') + '</span>' +
      '<button type="button" class="icon-btn wl-pop-x" data-wl-close aria-label="Close">✕</button></div>';
    if (lists.length > 6) h += '<input class="search wl-pop-f" type="search" placeholder="Find a watchlist" aria-label="Find a watchlist" value="' + esc(popFilter) + '">';
    if (lists.length) {
      h += '<ul class="wl-pop-list">' + shown.map(function (l) {
        var on = l.syms.indexOf(x) >= 0;
        return '<li><label><input type="checkbox" data-wl-id="' + esc(l.id) + '"' + (on ? ' checked' : '') + '> <span class="wl-pop-name">' + esc(l.name) +
          '</span> <span class="sub">' + l.syms.length + '</span></label></li>';
      }).join('') + (shown.length ? '' : '<li class="sub">No watchlist matches.</li>') + '</ul>';
    }
    h += '<form class="wl-pop-new" data-wl-new><label class="sr-only" for="wl-pop-name">New watchlist name</label>' +
      '<input id="wl-pop-name" class="search" type="text" maxlength="' + M.NAME_MAX + '" placeholder="New watchlist name" autocomplete="off">' +
      '<button class="btn primary" type="submit">' + (lists.length ? 'Create & add' : 'Create') + '</button></form>' +
      '<p class="wl-pop-msg' + (msgCls ? ' ' + msgCls : '') + '" role="status" aria-live="polite">' + esc(msg || '') + '</p>' +
      '<a class="wl-pop-link" href="#lists">Manage watchlists →</a>';
    return h;
  }
  function placePop() {
    if (!pop || !popAnchor) return;
    var r = popAnchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }
  function renderPop(msg, msgCls, focusSel) {
    pop.innerHTML = popBody(msg, msgCls);
    placePop();
    var f = focusSel && pop.querySelector(focusSel);
    if (f) f.focus();
  }
  function open(sym, anchor) {
    closePop(false);
    popSym = M.normSym(sym);
    popAnchor = anchor || null;
    pop = document.createElement('div');
    pop.className = 'wl-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Watchlists for ' + popSym);
    document.body.appendChild(pop);
    renderPop('', '', state.lists.length ? '.wl-pop-list input' : '#wl-pop-name');
  }
  function onPopChange(e) {
    var cb = e.target.closest('[data-wl-id]');
    if (!cb) return;
    var id = cb.getAttribute('data-wl-id'), l = M.get(state, id);
    var r = apply(M.toggle(state, id, popSym));
    if (r && r.error) { renderPop(r.error, 'bad'); return; }
    renderPop((r.added ? 'Added to ' : 'Removed from ') + (l ? l.name : 'the watchlist') + '. Saved.', 'good', '[data-wl-id="' + id + '"]');
  }
  function onPopSubmit(e) {
    if (!e.target.closest('[data-wl-new]')) return;
    e.preventDefault();
    var name = pop.querySelector('#wl-pop-name').value;
    var r = apply(M.create(state, name));
    if (r.error) { renderPop(r.error, 'bad', '#wl-pop-name'); pop.querySelector('#wl-pop-name').value = name; return; }
    apply(M.add(state, r.list.id, popSym));
    renderPop('Created "' + r.list.name + '" with ' + popSym + '. Saved.', 'good', '[data-wl-id="' + r.list.id + '"]');
  }

  document.addEventListener('click', function (e) {
    var star = e.target.closest && e.target.closest('.wl-star[data-wl]');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      if (pop && popAnchor === star) closePop(true); else open(star.getAttribute('data-wl'), star);
      return;
    }
    if (!pop) return;
    if (e.target.closest('[data-wl-close]')) { closePop(true); return; }
    if (e.target.closest('.wl-pop-link')) { closePop(false); return; }
    if (!pop.contains(e.target)) closePop(false);
  }, true);
  document.addEventListener('change', function (e) { if (pop && pop.contains(e.target)) onPopChange(e); });
  document.addEventListener('submit', function (e) { if (pop && pop.contains(e.target)) onPopSubmit(e); });
  document.addEventListener('input', function (e) {
    if (pop && e.target.classList && e.target.classList.contains('wl-pop-f')) {
      popFilter = e.target.value;
      var pos = e.target.selectionStart;
      renderPop('', '', '.wl-pop-f');
      var f = pop.querySelector('.wl-pop-f');
      if (f) f.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (pop && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePop(true); }
  }, true);
  window.addEventListener('resize', function () { closePop(false); });
  window.addEventListener('hashchange', function () { closePop(false); });
  document.addEventListener('scroll', function (e) { if (pop && !pop.contains(e.target)) placePop(); }, true);

  // another tab of this site changed the lists
  window.addEventListener('storage', function (e) {
    if (e.key !== 'sb:' + KEY) return;
    var next;
    try { next = M.load(e.newValue ? JSON.parse(e.newValue) : null); } catch (err) { return; }
    state = next;
    refreshStars();
    if (pop) renderPop('Updated from another tab.', '');
    tell('tab');
  });
  /** The lists as the sync made them (this browser's changes already merged in). */
  function replace(next) {
    var s = M.load(next);
    if (JSON.stringify(s) === JSON.stringify(state)) return;
    state = s;
    changed('sync');
    if (pop) renderPop('Updated from your other devices.', '');
  }

  SB.wlStar = starHtml;
  SB.watchlists = {
    state: function () { return state; },
    get: function (id) { return M.get(state, id); },
    create: function (name) { return apply(M.create(state, name)); },
    rename: function (id, name) { return apply(M.rename(state, id, name)); },
    remove: function (id) { return apply(M.remove(state, id)); },
    add: function (id, sym) { return apply(M.add(state, id, sym)); },
    addMany: function (id, text) { var r = M.addMany(state, id, text); apply(r); return r; },
    removeSym: function (id, sym) { return apply(M.removeSym(state, id, sym)); },
    toggle: function (id, sym) { return apply(M.toggle(state, id, sym)); },
    select: function (id) { if (M.get(state, id) && state.last !== id) { var s = JSON.parse(JSON.stringify(state)); s.last = id; state = s; persist(); } },
    has: function (sym) { return M.has(state, sym); },
    listsWith: function (sym) { return M.listsWith(state, sym); },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    saved: function () { return saveOk; },
    open: open,
    replace: replace
  };
  // first visit: find out whether this browser lets the site save at all
  if (!ui.store.get(KEY, null)) saveOk = ui.store.set(KEY, state);
})();
