/* My Watchlists (#lists): the viewer's own watchlists - create, rename, delete, search /
   filter, add and remove stocks. Saved in this browser (web/ui/watchlists.js) and, after the
   PIN is typed once on this device, in the owner's Google Sheet (web/ui/watchlist-sync.js:
   the same lists on every device and site); the ☆ next to any stock symbol adds to them too. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, M = SB.wlModel;
  var V = { q: '', sort: 'name', inList: '', edit: false, confirm: false };
  var PIN_WHERE = 'set it in your Google Sheet: menu Auto Bhavcopy › 3. Quarterly Results &amp; Trend Tags › My Watchlists sync: set / change PIN';

  SB.page('lists', {
    render: function (el, params, ctx) {
      var W = SB.watchlists;
      var msg = { text: '', cls: '' };
      var table = null;

      el.innerHTML = '<div class="page-head"><div><h1>My watchlists</h1><p>Your own lists of stocks. Press ☆ next to any stock symbol on the site, or add symbols here. ' +
        'Every change is saved at once in this browser - and, once this device is connected with your PIN, in your Google Sheet, ' +
        'so your phone and both sites show the same lists. Prices: ' +
        ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '</p></div></div>' +
        '<div id="wl-save"></div><div id="wl-sync"></div><div class="wl-layout"><aside class="card wl-side" aria-label="Watchlists"><div id="wl-side"></div></aside>' +
        '<section class="card wl-main" aria-live="polite"><div id="wl-main"></div></section></div>';

      function current() {
        var s = W.state();
        return M.get(s, s.last) || s.lists[0] || null;
      }
      function say(text, cls) { msg = { text: text, cls: cls || '' }; }

      // ---------- left: the watchlists ----------
      function drawSide() {
        var s = W.state(), cur = current();
        var found = M.search(s, V.q), order = M.sort(found.map(function (f) { return f.list; }), V.sort);
        var byId = {};
        found.forEach(function (f) { byId[f.list.id] = f; });
        $('#wl-side', el).innerHTML =
          '<form class="wl-create" id="wl-create"><label for="wl-new" class="wl-lbl">New watchlist</label><div class="controls" style="margin:0">' +
          '<input id="wl-new" class="search" type="text" maxlength="' + M.NAME_MAX + '" placeholder="e.g. Swing trades" autocomplete="off">' +
          '<button class="btn primary" type="submit">Create</button></div></form>' +
          (s.lists.length ? '<div class="controls" style="margin:12px 0 8px"><label class="sr-only" for="wl-q">Search watchlists</label>' +
            '<input id="wl-q" class="search" type="search" placeholder="Search watchlists or a symbol" value="' + esc(V.q) + '">' +
            '<label class="sr-only" for="wl-sort">Sort watchlists</label><select id="wl-sort" class="sel">' +
            [['name', 'Name A–Z'], ['count', 'Most stocks'], ['recent', 'Recently changed']].map(function (o) {
              return '<option value="' + o[0] + '"' + (V.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
            }).join('') + '</select></div>' +
            '<p class="sub" id="wl-side-count">' + F.int(order.length) + ' of ' + F.int(s.lists.length) + ' watchlist' + (s.lists.length === 1 ? '' : 's') + '</p>' +
            '<ul class="wl-names">' + order.map(function (l) {
              var f = byId[l.id];
              return '<li><button type="button" class="wl-name' + (cur && cur.id === l.id ? ' on' : '') + '" data-wl-pick="' + esc(l.id) + '"' +
                (cur && cur.id === l.id ? ' aria-current="true"' : '') + '><span class="wl-name-t">' + esc(l.name) + '</span><span class="wl-n">' + F.int(l.syms.length) + '</span>' +
                (f && f.by === 'symbol' ? '<span class="co">has ' + esc(f.syms.slice(0, 3).join(', ')) + (f.syms.length > 3 ? '…' : '') + '</span>' : '') + '</button></li>';
            }).join('') + '</ul>' + (order.length ? '' : '<p class="empty">No watchlist name or symbol matches “' + esc(V.q) + '”.</p>')
            : '<p class="empty">No watchlists yet. Create one above, or press ☆ next to any stock symbol.</p>');
      }

      // ---------- right: one watchlist ----------
      function rowsOf(l) {
        return l.syms.map(function (x) {
          var s = ctx.bySym[x];
          return s ? s : { sym: x, name: null, missing: true };
        }).filter(function (s) { return ui.textMatch(V.inList, [s.sym, s.name, s.ind, s.sector]); });
      }
      function drawMain() {
        var host = $('#wl-main', el), l = current();
        if (!l) {
          host.innerHTML = '<div class="card-head"><div><h2>Start a watchlist</h2><p>Name it on the left (for example “Swing trades” or “Long term”), then add stocks here or with the ☆ next to any symbol.</p></div></div>';
          return;
        }
        var head = V.edit
          ? '<form id="wl-rename" class="controls" style="margin:0"><label class="sr-only" for="wl-rename-in">Watchlist name</label>' +
            '<input id="wl-rename-in" class="search" type="text" maxlength="' + M.NAME_MAX + '" value="' + esc(l.name) + '">' +
            '<button class="btn primary" type="submit">Save name</button><button class="btn" type="button" id="wl-rename-cancel">Cancel</button></form>'
          : '<div class="wl-title"><h2>' + esc(l.name) + '</h2><span class="sub">' + F.int(l.syms.length) + ' stock' + (l.syms.length === 1 ? '' : 's') + '</span>' +
            '<div class="actions"><button class="btn" type="button" id="wl-rename-btn">Rename</button><button class="btn" type="button" id="wl-csv"' + (l.syms.length ? '' : ' disabled') + '>Export CSV</button>' +
            '<button class="btn danger" type="button" id="wl-del">Delete</button></div></div>';
        var confirm = V.confirm ? '<div class="note warn wl-confirm" role="alert">Delete “' + esc(l.name) + '” and its ' + F.int(l.syms.length) + ' stock' + (l.syms.length === 1 ? '' : 's') + '? This cannot be undone. ' +
          '<button class="btn danger" type="button" id="wl-del-yes">Delete</button> <button class="btn" type="button" id="wl-del-no">Keep it</button></div>' : '';
        host.innerHTML = head + confirm +
          '<form id="wl-add" class="controls" style="margin-top:12px"><label class="sr-only" for="wl-add-in">Add stocks</label>' +
          '<input id="wl-add-in" class="search" type="text" list="wl-syms" autocomplete="off" placeholder="Add symbols, e.g. TCS or TCS, INFY, SBIN">' +
          '<button class="btn primary" type="submit">Add</button></form>' +
          '<datalist id="wl-syms">' + ctx.stocks.map(function (s) { return '<option value="' + esc(s.sym) + '">' + esc(s.name || '') + '</option>'; }).join('') + '</datalist>' +
          '<p class="wl-msg ' + esc(msg.cls) + '" role="status">' + esc(msg.text) + '</p>' +
          (l.syms.length ? '<div class="controls"><label class="sr-only" for="wl-in">Filter this watchlist</label><input id="wl-in" class="search" type="search" placeholder="Filter this watchlist" value="' + esc(V.inList) + '">' +
            '<span class="count" id="wl-count"></span></div>' : '') +
          '<div id="wl-table"></div>';
        if (!l.syms.length) {
          $('#wl-table', el).innerHTML = '<p class="empty">No stocks yet. Type a symbol above, or press ☆ next to any stock symbol on the site.</p>';
          return;
        }
        table = new ui.Table({
          rows: [], pageSize: 50, sort: { key: 'sym', dir: 1 }, empty: 'No stock in this watchlist matches the filter',
          columns: [
            { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; },
              html: function (r) { return ui.stockCell(r.sym, r.missing ? 'not in the current Stock Blueprint data' : r.name); } },
            { key: 'name', label: 'Company', csvOnly: true },
            { key: 'price', label: 'Price', type: 'price' },
            { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
            { key: 'd10', label: '10D', type: 'pct' },
            { key: 'down52', label: 'vs 52W high', type: 'pct' },
            { key: 'ind', label: 'Basic industry', wrap: true },
            { key: 'sig', label: 'TTM Signal', type: 'badge' },
            { key: 'rm', label: '', noExport: true, html: function (r) {
              return '<button type="button" class="icon-btn wl-rm" data-wl-rm="' + esc(r.sym) + '" aria-label="Remove ' + esc(r.sym) + ' from ' + esc(l.name) + '" title="Remove from this watchlist">✕</button>';
            } }
          ]
        }).mount($('#wl-table', el));
        applyFilter();
      }
      function applyFilter() {
        var l = current();
        if (!table || !l) return;
        var rows = rowsOf(l);
        var c = $('#wl-count', el);
        if (c) c.textContent = F.int(rows.length) + ' of ' + F.int(l.syms.length);
        table.setRows(rows);
      }
      function drawSave() {
        $('#wl-save', el).innerHTML = W.saved() ? '' : '<div class="note bad">This browser is not letting the site save (private window or blocked site data). ' +
          'Your watchlists work until you close this tab but will not be kept.</div>';
      }
      // ---------- top: the same lists on every device (Google Sheet sync) ----------
      function when(iso) {
        var d = new Date(iso);
        if (!iso || isNaN(d.getTime())) return '';
        var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toDateString() === new Date().toDateString() ? 'today ' + t : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t;
      }
      function drawSync() {
        var S = SB.wlSync, host = $('#wl-sync', el);
        if (!S || !host) return;
        var s = S.status();
        if (s.phase === 'nohost') {
          host.innerHTML = '<p class="sub wl-sync-local">Keeping the same lists on every device works on the live site (Vercel or Firebase). Here the lists stay in this browser.</p>';
          return;
        }
        var head = '<div><h2 id="wl-sync-h">Same lists on every device</h2>';
        if (!s.linked) {
          var why = s.phase === 'pin' ? (/locked/i.test(s.message) ? s.message.charAt(0).toUpperCase() + s.message.slice(1) + '.'
              : !s.message || /wrong pin/i.test(s.message) ? 'Wrong PIN - type it again.' : s.message)
            : s.phase === 'nopin' ? 'Your Google Sheet has no watchlist PIN yet - ' + PIN_WHERE + ', then type it here.'
            : '';
          var checking = s.phase === 'syncing';
          host.innerHTML = '<section class="card wl-sync" aria-labelledby="wl-sync-h"><div class="wl-sync-row">' + head +
            '<p class="sub">Now these lists are saved only in this browser. Type your watchlist PIN once to keep them in your Google Sheet: ' +
            'then your phone, this site and the other site (Vercel / Firebase) all show the same lists. No PIN yet? ' + PIN_WHERE + '.</p></div></div>' +
            '<form id="wl-pin-form" class="controls"><label class="sr-only" for="wl-pin">Watchlist PIN</label>' +
            '<input id="wl-pin" class="search" type="password" maxlength="20" autocomplete="off" placeholder="Watchlist PIN" aria-describedby="wl-pin-msg">' +
            '<button class="btn primary" type="submit"' + (checking ? ' disabled' : '') + '>Connect</button></form>' +
            '<p id="wl-pin-msg" class="wl-msg' + (why ? ' bad' : '') + '" role="status">' + (checking ? 'Checking the PIN with your Google Sheet…' : s.phase === 'nopin' ? why : esc(why)) + '</p></section>';
          return;
        }
        var line = s.phase === 'syncing' ? 'Syncing with your Google Sheet…'
          : s.phase === 'ok' ? '✓ In step with your Google Sheet' + (s.at ? ' - last synced ' + when(s.at) : '') + '. Changes made here show on your other devices too.'
          : s.phase === 'locked' ? 'Sync paused - ' + s.message + '. Your lists stay in this browser meanwhile.'
          : s.phase === 'offline' ? 'Could not reach your Google Sheet just now (' + s.message + '). Your changes are kept in this browser and sent with the next sync.'
          : 'Sync is not working: ' + s.message + '.';
        var cls = s.phase === 'ok' ? ' good' : s.phase === 'syncing' ? '' : ' bad';
        host.innerHTML = '<section class="card wl-sync" aria-labelledby="wl-sync-h"><div class="wl-sync-row">' + head +
          '<p class="wl-msg' + cls + '" role="status">' + esc(line) + '</p></div>' +
          '<div class="actions"><button class="btn" type="button" id="wl-sync-now"' + (s.phase === 'syncing' ? ' disabled' : '') + '>Sync now</button>' +
          '<button class="btn" type="button" id="wl-sync-off">Stop sync on this device</button></div></div></section>';
      }
      function drawAll() { drawSave(); drawSync(); drawSide(); drawMain(); }

      // ---------- events ----------
      el.addEventListener('submit', function (e) {
        var f = e.target;
        if (f.id === 'wl-pin-form') {
          e.preventDefault();
          var pin = $('#wl-pin', el).value;
          if (!pin.trim()) { $('#wl-pin', el).focus(); return; }
          SB.wlSync.connect(pin).then(function (s) {
            if (!s.linked && el.isConnected && $('#wl-pin', el)) $('#wl-pin', el).focus();
          });
          return;
        }
        if (f.id === 'wl-create') {
          e.preventDefault();
          var inp = $('#wl-new', el), r = W.create(inp.value);
          if (r.error) { say(r.error, 'bad'); drawMain(); $('#wl-new', el).value = inp.value; return; }
          V.q = ''; V.edit = false; V.confirm = false;
          say('Created “' + r.list.name + '”. Add stocks below.', 'good');
          drawAll();
          $('#wl-add-in', el).focus();
        } else if (f.id === 'wl-rename') {
          e.preventDefault();
          var l = current(), r2 = W.rename(l.id, $('#wl-rename-in', el).value);
          if (r2.error) { say(r2.error, 'bad'); var v = $('#wl-rename-in', el).value; drawMain(); $('#wl-rename-in', el).value = v; $('#wl-rename-in', el).focus(); return; }
          V.edit = false;
          say('Renamed. Saved.', 'good');
          drawAll();
        } else if (f.id === 'wl-add') {
          e.preventDefault();
          var l2 = current(), text = $('#wl-add-in', el).value;
          if (!text.trim()) return;
          var r3 = W.addMany(l2.id, text), parts = [];
          if (r3.added.length) parts.push('Added ' + r3.added.join(', ') + '.');
          if (r3.dup.length) parts.push(r3.dup.join(', ') + (r3.dup.length === 1 ? ' is' : ' are') + ' already in this watchlist.');
          if (r3.bad.length) parts.push('Not a symbol: ' + r3.bad.join(', ') + '.');
          if (r3.full.length) parts.push('Not added - a watchlist holds at most ' + F.int(M.MAX_SYMS) + ' stocks: ' + r3.full.slice(0, 20).join(', ') + (r3.full.length > 20 ? ' and ' + F.int(r3.full.length - 20) + ' more' : '') + '.');
          var unknown = r3.added.filter(function (x) { return !ctx.bySym[x]; });
          if (unknown.length) parts.push(unknown.join(', ') + ' ' + (unknown.length === 1 ? 'is' : 'are') + ' not in the current Stock Blueprint data (kept anyway).');
          say(parts.join(' '), r3.added.length && !r3.bad.length && !r3.full.length ? 'good' : r3.added.length ? '' : 'bad');
          drawAll();
          $('#wl-add-in', el).focus();
        }
      });
      el.addEventListener('click', function (e) {
        var pick = e.target.closest('[data-wl-pick]');
        if (pick) { W.select(pick.getAttribute('data-wl-pick')); V.edit = false; V.confirm = false; V.inList = ''; say(''); drawSide(); drawMain(); var b = el.querySelector('[data-wl-pick="' + pick.getAttribute('data-wl-pick') + '"]'); if (b) b.focus(); return; }
        var rm = e.target.closest('[data-wl-rm]');
        if (rm) { var x = rm.getAttribute('data-wl-rm'); W.removeSym(current().id, x); say('Removed ' + x + '. Saved.', 'good'); drawSide(); drawMain(); return; }
        if (e.target.closest('#wl-sync-now')) { SB.wlSync.syncNow(); return; }
        if (e.target.closest('#wl-sync-off')) { SB.wlSync.disconnect(); return; }
        if (e.target.closest('#wl-rename-btn')) { V.edit = true; V.confirm = false; drawMain(); var i = $('#wl-rename-in', el); i.focus(); i.select(); return; }
        if (e.target.closest('#wl-rename-cancel')) { V.edit = false; say(''); drawMain(); return; }
        if (e.target.closest('#wl-del')) { V.confirm = true; drawMain(); $('#wl-del-no', el).focus(); return; }
        if (e.target.closest('#wl-del-no')) { V.confirm = false; drawMain(); return; }
        if (e.target.closest('#wl-del-yes')) {
          var gone = current();
          W.remove(gone.id);
          V.confirm = false; V.inList = '';
          say('Deleted “' + gone.name + '”.', 'good');
          drawAll();
          return;
        }
        if (e.target.closest('#wl-csv') && table) {
          ui.download('watchlist-' + current().name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() + '.csv', ui.toCsv(table.toCsvRows()));
        }
      });
      var timer;
      el.addEventListener('input', function (e) {
        if (e.target.id === 'wl-q') {
          clearTimeout(timer);
          var pos = e.target.selectionStart;
          timer = setTimeout(function () { V.q = e.target.value; drawSide(); var q = $('#wl-q', el); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 150);
        } else if (e.target.id === 'wl-in') {
          V.inList = e.target.value.trim();
          applyFilter();
        }
      });
      el.addEventListener('change', function (e) { if (e.target.id === 'wl-sort') { V.sort = e.target.value; drawSide(); } });

      // stars and other tabs change the lists too: redraw while this page is open
      var off = W.onChange(function () {
        if (!el.isConnected) { off(); return; }
        drawSide();
        if (!V.edit) drawMain();
      });
      var offSync = SB.wlSync ? SB.wlSync.onStatus(function () {
        if (!el.isConnected) { offSync(); return; }
        var typing = document.activeElement && document.activeElement.id === 'wl-pin' ? $('#wl-pin', el).value : null;
        drawSync();
        if (typing != null && $('#wl-pin', el)) { $('#wl-pin', el).value = typing; $('#wl-pin', el).focus(); }
      }) : function () {};
      drawAll();
    }
  });
})();
