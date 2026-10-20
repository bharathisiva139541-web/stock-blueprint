// Dhan scrip master (instrument list) -> NSE equity symbol -> securityId.
//
// Source: the public CSV https://images.dhan.co/api-data/api-scrip-master.csv
// (no login needed; the access token is NEVER sent to it). Columns used:
// SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_SMST_SECURITY_ID, SEM_INSTRUMENT_NAME,
// SEM_TRADING_SYMBOL, SEM_SERIES, SM_SYMBOL_NAME (optional).
// The file is large (all exchanges + F&O), so it is read as a stream and
// only NSE cash-equity rows are kept.
(function () {
  'use strict';

  const fetchUtil = require('../fetch-util');

  const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
  const MAX_BYTES = 200 * 1024 * 1024;

  // NSE equity series kept (lower rank wins if a symbol appears twice).
  // EQ normal, BE/BZ trade-for-trade, SM/ST SME platform, SZ SME trade-for-trade.
  const EQUITY_SERIES_RANK = { EQ: 0, BE: 1, BZ: 2, SM: 3, ST: 4, SZ: 5 };

  /** Splits one CSV line (RFC 4180 quotes, "" escapes). */
  function splitCsvLine(line) {
    if (line.indexOf('"') < 0) return line.split(',');
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; }
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /**
   * Incremental parser: feed lines with .line(text), then .result() ->
   *   { ok:true, bySymbol: Map(symbol -> { securityId, series, name }), count, rows }
   *   { ok:false, reason }
   */
  function createScripParser() {
    let idx = null, headerError = null, rows = 0, fastPrefix = null;
    const bySymbol = new Map();

    function header(cells) {
      const h = cells.map(function (c) { return String(c).trim().toUpperCase(); });
      const find = function (name) { return h.indexOf(name); };
      idx = {
        exch: find('SEM_EXM_EXCH_ID'), seg: find('SEM_SEGMENT'), id: find('SEM_SMST_SECURITY_ID'),
        inst: find('SEM_INSTRUMENT_NAME'), sym: find('SEM_TRADING_SYMBOL'), series: find('SEM_SERIES'),
        name: find('SM_SYMBOL_NAME')
      };
      if (idx.exch < 0 || idx.seg < 0 || idx.id < 0 || idx.sym < 0 || idx.series < 0) {
        headerError = 'scrip master header is missing required SEM_* columns';
      }
      // Cheap pre-filter when the file starts with exchange, segment (it does today).
      if (idx.exch === 0 && idx.seg === 1) fastPrefix = 'NSE,E,';
    }

    function line(raw) {
      if (headerError) return;
      let text = String(raw);
      if (text.charCodeAt(text.length - 1) === 13) text = text.slice(0, -1); // CR
      if (!text) return;
      if (idx === null) { header(splitCsvLine(text.replace(/^﻿/, ''))); return; }
      rows++;
      if (fastPrefix && text.indexOf(fastPrefix) !== 0 && text.indexOf('"') !== 0) return;
      const c = splitCsvLine(text);
      if (String(c[idx.exch]).trim().toUpperCase() !== 'NSE') return;
      if (String(c[idx.seg]).trim().toUpperCase() !== 'E') return;
      if (idx.inst >= 0) {
        const inst = String(c[idx.inst] || '').trim().toUpperCase();
        if (inst && inst !== 'EQUITY') return;
      }
      const series = String(c[idx.series] || '').trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(EQUITY_SERIES_RANK, series)) return;
      const sym = String(c[idx.sym] || '').trim().toUpperCase();
      const id = String(c[idx.id] || '').trim();
      if (!sym || !/^\d{1,12}$/.test(id)) return;
      const prev = bySymbol.get(sym);
      if (prev && EQUITY_SERIES_RANK[prev.series] <= EQUITY_SERIES_RANK[series]) return;
      bySymbol.set(sym, { securityId: id, series: series,
                          name: idx.name >= 0 ? String(c[idx.name] || '').trim() : '' });
    }

    function result() {
      if (headerError) return { ok: false, reason: headerError };
      if (idx === null) return { ok: false, reason: 'scrip master is empty' };
      if (!bySymbol.size) return { ok: false, reason: 'scrip master has no NSE equity rows' };
      return { ok: true, bySymbol: bySymbol, count: bySymbol.size, rows: rows };
    }

    return { line: line, result: result };
  }

  /** Parses a whole CSV string (used by tests and as a fallback). */
  function parseScripMaster(text) {
    const p = createScripParser();
    String(text || '').split('\n').forEach(p.line);
    return p.result();
  }

  /** Streams a Response body line by line into onLine. Falls back to res.text(). */
  async function readLines(res, onLine) {
    const body = res && res.body;
    if (body && typeof body.getReader === 'function' && typeof TextDecoder === 'function') {
      const reader = body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '', bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value ? chunk.value.length : 0;
        if (bytes > MAX_BYTES) { try { reader.cancel(); } catch { /* ignore */ } throw new Error('scrip master too large'); }
        buf += dec.decode(chunk.value, { stream: true });
        let start = 0, i;
        while ((i = buf.indexOf('\n', start)) >= 0) { onLine(buf.slice(start, i)); start = i + 1; }
        buf = buf.slice(start);
      }
      buf += dec.decode();
      if (buf) onLine(buf);
      return;
    }
    const text = await res.text();
    String(text || '').split('\n').forEach(onLine);
  }

  /**
   * Downloads and parses the scrip master. Never throws:
   *   { ok:true, bySymbol, count, loadedAt } | { ok:false, reason }
   */
  async function loadScripMaster(opts) {
    const o = opts || {};
    const f = fetchUtil.pickFetch(o.fetch);
    if (!f) return { ok: false, reason: 'fetch is not available' };
    const url = o.url || SCRIP_MASTER_URL;
    try {
      return await fetchUtil.withTimeout(o.timeoutMs || 20000, async function (signal) {
        const res = await f(url, { method: 'GET', headers: { Accept: 'text/csv' }, signal: signal });
        if (!res || res.status < 200 || res.status >= 300) {
          return { ok: false, reason: 'scrip master download failed (HTTP ' + (res ? res.status : 0) + ')' };
        }
        const p = createScripParser();
        await readLines(res, p.line);
        const r = p.result();
        if (r.ok) r.loadedAt = typeof o.now === 'function' ? o.now() : Date.now();
        return r;
      });
    } catch (err) {
      return { ok: false, reason: err && err.code === 'TIMEOUT' ? 'scrip master download timed out'
                                                               : 'scrip master download failed (network)' };
    }
  }

  module.exports = {
    SCRIP_MASTER_URL: SCRIP_MASTER_URL,
    EQUITY_SERIES_RANK: EQUITY_SERIES_RANK,
    splitCsvLine: splitCsvLine,
    createScripParser: createScripParser,
    parseScripMaster: parseScripMaster,
    loadScripMaster: loadScripMaster
  };
})();
