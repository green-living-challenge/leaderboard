/* GLC hub: settings, network and browser storage. Every function here is
   written so that it never throws: failures come back as values.
   Loaded in the browser as window.GLCData and in Node with require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLCData = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Wraps browser storage so a private window, blocked cookies or a full quota
  // never break the page. getStorage is called on every use and may itself throw
  // (Safari and Chrome throw on the `localStorage` getter when storage is blocked).
  function safeStorage(getStorage) {
    function store() {
      try {
        return getStorage() || null;
      } catch (e) {
        return null;
      }
    }
    return {
      get: function (key) {
        try {
          var s = store();
          if (!s) return null;
          var raw = s.getItem(key);
          return raw == null ? null : JSON.parse(raw);
        } catch (e) {
          return null;
        }
      },
      set: function (key, value) {
        try {
          var s = store();
          if (!s) return false;
          s.setItem(key, JSON.stringify(value));
          return true;
        } catch (e) {
          return false;
        }
      }
    };
  }

  // api from config.json + route (+ id) -> absolute URL. Relative api values are
  // resolved against base, which lets the local fixture server use a path.
  function buildUrl(api, route, id, base) {
    var u = new URL(api, base);
    u.searchParams.set('route', route);
    if (id) u.searchParams.set('id', id);
    return u.toString();
  }

  // GET a URL and read the body. Resolves to { ok: true, text } or
  // { ok: false, error: { kind: 'timeout' | 'network' | 'http', status? } }.
  // No custom headers, so the browser sends a simple request with no CORS preflight.
  function fetchText(url, options) {
    var opts = options || {};
    var fetchImpl = opts.fetchImpl;
    var timeoutMs = opts.timeoutMs || 20000;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, timeoutMs);
    var init = { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer' };
    if (controller) init.signal = controller.signal;
    return Promise.resolve()
      .then(function () { return fetchImpl(url, init); })
      .then(function (res) {
        if (!res.ok) return { ok: false, error: { kind: 'http', status: res.status } };
        return res.text().then(function (body) { return { ok: true, text: body }; });
      })
      .catch(function () {
        return { ok: false, error: { kind: timedOut ? 'timeout' : 'network' } };
      })
      .then(function (result) {
        clearTimeout(timer);
        if (timedOut && !result.ok) return { ok: false, error: { kind: 'timeout' } };
        return result;
      });
  }

  // GET a URL and parse JSON. Resolves to { ok: true, json } or
  // { ok: false, error: { kind: 'timeout' | 'network' | 'http' | 'parse', status? } }.
  function fetchJson(url, options) {
    return fetchText(url, options).then(function (res) {
      if (!res.ok) return res;
      try {
        return { ok: true, json: JSON.parse(res.text) };
      } catch (e) {
        return { ok: false, error: { kind: 'parse' } };
      }
    });
  }

  // The published CSV address of one tab of the public copy (spec section 6, "Public copy").
  function buildCsvUrl(csv, gid, base) {
    var u = new URL(csv, base);
    u.searchParams.set('gid', String(gid));
    u.searchParams.set('single', 'true');
    u.searchParams.set('output', 'csv');
    return u.toString();
  }

  // CSV text -> rows of cells: quoted cells, doubled quotes, commas and line
  // breaks inside quotes, CRLF or LF. null if a quote is never closed.
  function parseCsv(text) {
    if (typeof text !== 'string') return null;
    var s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    var rows = [];
    var row = [];
    var field = '';
    var quoted = false;
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (quoted) {
        if (c === '"' && s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i++; continue; }
        field += c;
        i++;
        continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += c === '\r' && s.charAt(i + 1) === '\n' ? 2 : 1;
        continue;
      }
      field += c;
      i++;
    }
    if (quoted) return null;
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // One tab of the public copy -> { ok: true, json } or { ok: false, error: { kind: 'parse' } }.
  // The row whose first cell is key holds the payload in up to three parts. On the
  // registry tab, the heartbeat row is the registry's syncedAt (null if missing).
  function payloadFromCsv(text, key) {
    var rows = parseCsv(text);
    var found = null;
    var heartbeat = null;
    (rows || []).forEach(function (r) {
      if (r[0] === key && !found) found = r;
      if (r[0] === 'heartbeat' && r[1]) heartbeat = r[1];
    });
    if (!found) return { ok: false, error: { kind: 'parse' } };
    var json;
    try {
      json = JSON.parse(found.slice(1, 4).join(''));
    } catch (e) {
      return { ok: false, error: { kind: 'parse' } };
    }
    if (key === 'registry' && json && typeof json === 'object' && !Array.isArray(json)) json.syncedAt = heartbeat;
    return { ok: true, json: json };
  }

  function isGid(v) {
    return typeof v === 'number' && v >= 0 && v <= 2147483647 && Math.floor(v) === v;
  }

  // One payload: the public copy first, then the API (spec section 7, "Loading and errors").
  // The copy is skipped without a csv address or a tab (gid), and abandoned when it fails,
  // takes longer than copyMs, or holds something check(json).ok refuses. The API then gets
  // what is left of giveUpMs, at least one second.
  // opts: { api, csv, route, id, gid, base, fetchImpl, check, copyMs, giveUpMs, now }
  // Resolves to { ok: true, json, source: 'copy' | 'api' } or { ok: false, error }.
  // The API's answer is passed on as it is, error bodies included.
  function loadPayload(opts) {
    var now = opts.now || Date.now;
    var started = now();
    var registry = opts.route === 'registry';
    var gid = registry ? 0 : opts.gid;
    var key = registry ? 'registry' : 'challenge:' + opts.id;
    function usable(json) {
      try {
        return !!opts.check(json).ok;
      } catch (e) {
        return false;
      }
    }
    var copy = opts.csv && isGid(gid)
      ? Promise.resolve()
        .then(function () {
          return fetchText(buildCsvUrl(opts.csv, gid, opts.base), { fetchImpl: opts.fetchImpl, timeoutMs: opts.copyMs });
        })
        .then(function (res) { return res.ok ? payloadFromCsv(res.text, key) : res; })
        .catch(function () { return { ok: false }; })
      : Promise.resolve({ ok: false });
    return copy.then(function (res) {
      if (res.ok && usable(res.json)) return { ok: true, json: res.json, source: 'copy' };
      var left = Math.max(1000, opts.giveUpMs - (now() - started));
      return Promise.resolve()
        .then(function () {
          return fetchJson(buildUrl(opts.api, opts.route, opts.id, opts.base), { fetchImpl: opts.fetchImpl, timeoutMs: left });
        })
        .catch(function () { return { ok: false, error: { kind: 'network' } }; })
        .then(function (api) { return api.ok ? { ok: true, json: api.json, source: 'api' } : api; });
    });
  }

  // Reads config.json next to the page. Resolves to { ok: true, api, csv } or
  // { ok: false, error: { kind: 'config' | 'noapi' } }. csv, the public copy's
  // published link, is optional and null when missing.
  function loadConfig(fetchImpl, base, timeoutMs) {
    var url = new URL('config.json', base).toString();
    return fetchJson(url, { fetchImpl: fetchImpl, timeoutMs: timeoutMs || 10000 }).then(function (res) {
      if (!res.ok || !res.json || typeof res.json !== 'object') return { ok: false, error: { kind: 'config' } };
      var api = typeof res.json.api === 'string' ? res.json.api.trim() : '';
      if (!api) return { ok: false, error: { kind: 'noapi' } };
      var csv = typeof res.json.csv === 'string' ? res.json.csv.trim() : '';
      return { ok: true, api: api, csv: csv || null };
    });
  }

  return {
    safeStorage: safeStorage, buildUrl: buildUrl, fetchText: fetchText, fetchJson: fetchJson, loadConfig: loadConfig,
    buildCsvUrl: buildCsvUrl, parseCsv: parseCsv, payloadFromCsv: payloadFromCsv, loadPayload: loadPayload
  };
});
