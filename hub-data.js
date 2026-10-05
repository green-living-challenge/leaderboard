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

  // GET a URL and parse JSON. Resolves to { ok: true, json } or
  // { ok: false, error: { kind: 'timeout' | 'network' | 'http' | 'parse', status? } }.
  // No custom headers, so the browser sends a simple request with no CORS preflight.
  function fetchJson(url, options) {
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
        return res.text().then(function (body) {
          try {
            return { ok: true, json: JSON.parse(body) };
          } catch (e) {
            return { ok: false, error: { kind: 'parse' } };
          }
        });
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

  // Reads config.json next to the page. Resolves to { ok: true, api } or
  // { ok: false, error: { kind: 'config' | 'noapi' } }.
  function loadConfig(fetchImpl, base, timeoutMs) {
    var url = new URL('config.json', base).toString();
    return fetchJson(url, { fetchImpl: fetchImpl, timeoutMs: timeoutMs || 10000 }).then(function (res) {
      if (!res.ok || !res.json || typeof res.json !== 'object') return { ok: false, error: { kind: 'config' } };
      var api = typeof res.json.api === 'string' ? res.json.api.trim() : '';
      if (!api) return { ok: false, error: { kind: 'noapi' } };
      return { ok: true, api: api };
    });
  }

  return { safeStorage: safeStorage, buildUrl: buildUrl, fetchJson: fetchJson, loadConfig: loadConfig };
});
