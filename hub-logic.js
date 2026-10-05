/* GLC hub: pure logic. No DOM, no network, no storage, no console output.
   Loaded in the browser as window.GLCLogic and in Node with require().
   Sections are added in order by the hub plan's tasks 2, 3 and 4. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLCLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var api = {};

  // ---------- section A: dates, state, challenge lists, addresses ----------

  var TIMEZONE = 'Asia/Dubai';
  var TIMING = { slowMs: 4000, giveUpMs: 20000, staleSyncMinutes: 30 };
  var STATES = ['upcoming', 'live', 'ended', 'final'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function text(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function isDay(s) {
    if (typeof s !== 'string') return false;
    var m = DAY_RE.exec(s);
    if (!m) return false;
    var month = Number(m[2]);
    var day = Number(m[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  var dayParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  var stampParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function partsOf(formatter, date) {
    var out = {};
    formatter.formatToParts(date).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }

  // Today's calendar day in Dubai as 'YYYY-MM-DD', whatever the device's time zone.
  function todayInDubai(nowMs) {
    var p = partsOf(dayParts, new Date(nowMs));
    return p.year + '-' + p.month + '-' + p.day;
  }

  // '2026-10-12' -> '12 Oct'. Never builds a Date from a day string.
  function formatDay(day) {
    if (!isDay(day)) return '';
    var m = DAY_RE.exec(day);
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1];
  }

  function formatRange(start, end) {
    if (!isDay(start) || !isDay(end)) return '';
    var sy = start.slice(0, 4);
    var ey = end.slice(0, 4);
    if (sy === ey) return formatDay(start) + ' to ' + formatDay(end) + ' ' + ey;
    return formatDay(start) + ' ' + sy + ' to ' + formatDay(end) + ' ' + ey;
  }

  // ISO timestamp -> '14 Oct, 21:47' in Dubai time. '' when unreadable.
  function formatStamp(iso) {
    if (typeof iso !== 'string') return '';
    var ms = Date.parse(iso);
    if (!isFinite(ms)) return '';
    var p = partsOf(stampParts, new Date(ms));
    return Number(p.day) + ' ' + MONTHS[Number(p.month) - 1] + ', ' + p.hour + ':' + p.minute;
  }

  // Spec section 6: recompute state from startDate, endDate and closed with today in Dubai.
  // isFinal is the challenge payload's `final` flag, which also means final.
  // With unreadable dates, fall back to the server's state, else 'ended'.
  function deriveState(challenge, today, isFinal) {
    var c = isObject(challenge) ? challenge : {};
    if (c.closed === true || isFinal === true) return 'final';
    if (isDay(c.startDate) && isDay(c.endDate) && isDay(today)) {
      if (today < c.startDate) return 'upcoming';
      if (today <= c.endDate) return 'live';
      return 'ended';
    }
    return STATES.indexOf(c.state) >= 0 ? c.state : 'ended';
  }

  function badgeText(state, startDate) {
    if (state === 'upcoming') return isDay(startDate) ? 'Starts ' + formatDay(startDate) : 'Starting soon';
    if (state === 'live') return 'Live';
    if (state === 'final') return 'Final results';
    return 'Ended, results being checked';
  }

  function emptyText(state, startDate) {
    if (state === 'upcoming') {
      return isDay(startDate)
        ? 'Starts on ' + formatDay(startDate) + '. Results will appear here once entries come in.'
        : 'This challenge has not started yet.';
    }
    if (state === 'live') return 'No entries yet. Be the first to log one.';
    return 'No entries were counted in this challenge.';
  }

  function challengeList(registry) {
    return isObject(registry) && Array.isArray(registry.challenges)
      ? registry.challenges.filter(function (c) { return isObject(c) && ID_RE.test(String(c.id)); })
      : [];
  }

  function findChallenge(registry, id) {
    var list = challengeList(registry);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function byStartAsc(a, b) {
    var x = String(a.startDate);
    var y = String(b.startDate);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function byEndDesc(a, b) {
    var x = String(a.endDate);
    var y = String(b.endDate);
    return x > y ? -1 : x < y ? 1 : 0;
  }

  // current: live (by start date) then upcoming (by start date). past: ended and final, latest end first.
  function groupChallenges(registry, today) {
    var live = [];
    var upcoming = [];
    var past = [];
    challengeList(registry).forEach(function (c) {
      var s = deriveState(c, today, false);
      if (s === 'live') live.push(c);
      else if (s === 'upcoming') upcoming.push(c);
      else past.push(c);
    });
    return { current: live.sort(byStartAsc).concat(upcoming.sort(byStartAsc)), past: past.sort(byEndDesc) };
  }

  // The registry's defaultId when it names a listed challenge, else the spec's rule:
  // first live, else next upcoming, else most recently ended. null for an empty list.
  function pickDefault(registry, today) {
    if (isObject(registry) && findChallenge(registry, registry.defaultId)) return registry.defaultId;
    var g = groupChallenges(registry, today);
    if (g.current.length) return g.current[0].id;
    if (g.past.length) return g.past[0].id;
    return null;
  }

  // '#/c/<id>' selects a challenge. Anything else, including '#/me/...' (slice 3),
  // means "the default challenge". Only well-formed ids are ever sent to the API.
  function parseHash(hash) {
    var m = /^#\/c\/([^/?#]+)$/.exec(typeof hash === 'string' ? hash : '');
    if (m) {
      var id;
      try {
        id = decodeURIComponent(m[1]);
      } catch (e) {
        id = '';
      }
      if (ID_RE.test(id)) return { view: 'challenge', id: id };
    }
    return { view: 'default', id: null };
  }

  function challengeHash(id) {
    return '#/c/' + id;
  }

  // Only http and https links are ever put in an href.
  function safeUrl(u) {
    if (typeof u !== 'string' || !u) return null;
    try {
      var parsed = new URL(u);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? u : null;
    } catch (e) {
      return null;
    }
  }

  Object.assign(api, {
    TIMEZONE: TIMEZONE,
    TIMING: TIMING,
    isDay: isDay,
    todayInDubai: todayInDubai,
    formatDay: formatDay,
    formatRange: formatRange,
    formatStamp: formatStamp,
    deriveState: deriveState,
    badgeText: badgeText,
    emptyText: emptyText,
    findChallenge: findChallenge,
    groupChallenges: groupChallenges,
    pickDefault: pickDefault,
    parseHash: parseHash,
    challengeHash: challengeHash,
    safeUrl: safeUrl
  });

  // ---------- section B: numbers, rankings, colours, halls ----------

  var ROW_LIMIT = 20;
  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var DARK_TEXT = '#111827';
  var LIGHT_TEXT = '#FFFFFF';
  var NEUTRAL_HALL = '#64748B';
  var DEFAULT_THEME = { headerFrom: '#065F46', headerTo: '#0F766E', accent: '#F59E0B' };
  var numberFormat = new Intl.NumberFormat('en-US');

  function formatNumber(n) {
    return numberFormat.format(num(n));
  }

  // Width of a progress bar in percent of the leader's points, 0 to 100.
  function barPercent(points, max) {
    var p = num(points);
    var m = num(max);
    if (m <= 0 || p <= 0) return 0;
    return Math.min(100, Math.round((p / m) * 100));
  }

  // One tile per number the payload gives. A non-competitive payload has no points.
  function statTiles(totals) {
    var t = isObject(totals) ? totals : {};
    return [
      { key: 'participants', label: 'Participants' },
      { key: 'submissions', label: 'Submissions' },
      { key: 'points', label: 'Points' }
    ].filter(function (tile) {
      return typeof t[tile.key] === 'number' && isFinite(t[tile.key]);
    }).map(function (tile) {
      return { key: tile.key, label: tile.label, value: formatNumber(t[tile.key]) };
    });
  }

  // Competition ranking (1, 2, 2, 4) over rows already ordered by points, highest first.
  function competitionRanks(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var rank = i > 0 && rows[i].points === rows[i - 1].points ? out[i - 1].rank : i + 1;
      out.push(Object.assign({}, rows[i], { rank: rank }));
    }
    return out;
  }

  function hasValidRank(s) {
    return typeof s.rank === 'number' && s.rank >= 1 && Math.floor(s.rank) === s.rank;
  }

  // Students -> display rows. Keeps the server's order and ranks when every row has one.
  // Otherwise sorts by points, then name, and computes competition ranks itself.
  function rankRows(students) {
    var list = Array.isArray(students) ? students.filter(isObject) : [];
    var rows = list.map(function (s, i) {
      return {
        key: text(s.pid) || 'row-' + i,
        name: text(s.name) || 'Resident',
        hall: text(s.hall),
        points: num(s.points),
        rank: s.rank
      };
    });
    if (rows.length && rows.every(hasValidRank)) return rows;
    rows.sort(function (a, b) {
      return b.points - a.points || a.name.localeCompare(b.name);
    });
    return competitionRanks(rows);
  }

  // The first three rows, in rank order for screen readers, each with its podium place
  // and the CSS order that draws them as second, first, third.
  function podiumSlots(rows) {
    var order = { 1: 2, 2: 1, 3: 3 };
    return (rows || []).slice(0, 3).map(function (row, i) {
      return { place: i + 1, order: order[i + 1], row: row };
    });
  }

  function visibleRows(rows, expanded, limit) {
    var n = typeof limit === 'number' ? limit : ROW_LIMIT;
    var list = rows || [];
    return expanded || list.length <= n ? list : list.slice(0, n);
  }

  function parseHex(hex) {
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
    var h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // WCAG 2 contrast ratio between two hex colours, or 0 if either is unreadable.
  function contrastRatio(a, b) {
    var ra = parseHex(a);
    var rb = parseHex(b);
    if (!ra || !rb) return 0;
    var la = luminance(ra);
    var lb = luminance(rb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // White or near-black text, whichever reads better on every background given.
  function readableTextOn() {
    var bgs = Array.prototype.slice.call(arguments).filter(function (c) { return parseHex(c); });
    if (!bgs.length) return LIGHT_TEXT;
    function worst(fg) {
      return Math.min.apply(null, bgs.map(function (bg) { return contrastRatio(fg, bg); }));
    }
    return worst(LIGHT_TEXT) >= worst(DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
  }

  // Descriptor theme -> CSS custom properties. Bad or missing colours fall back to Emerald.
  function themeVars(theme) {
    var t = isObject(theme) ? theme : {};
    var from = parseHex(t.headerFrom) ? t.headerFrom : DEFAULT_THEME.headerFrom;
    var to = parseHex(t.headerTo) ? t.headerTo : DEFAULT_THEME.headerTo;
    var accent = parseHex(t.accent) ? t.accent : DEFAULT_THEME.accent;
    return {
      '--glc-from': from,
      '--glc-to': to,
      '--glc-accent': accent,
      '--glc-on-header': readableTextOn(from, to),
      '--glc-on-accent': readableTextOn(accent)
    };
  }

  function hallIndex(registryHalls) {
    var index = {};
    (Array.isArray(registryHalls) ? registryHalls : []).forEach(function (h) {
      if (isObject(h) && text(h.code)) index[text(h.code)] = h;
    });
    return index;
  }

  function groupLabel(group) {
    if (group === 'women') return "Women's halls";
    if (group === 'men') return "Men's halls";
    var g = text(group);
    return g ? g.charAt(0).toUpperCase() + g.slice(1) + ' halls' : '';
  }

  // Label, group and colours for one hall code. Unknown codes get a neutral grey.
  function hallStyle(index, code) {
    var reg = index[code] || {};
    var color = parseHex(reg.color) ? reg.color : NEUTRAL_HALL;
    return { label: text(reg.label) || code, group: text(reg.group), color: color, onColor: readableTextOn(color) };
  }

  // Challenge payload halls + registry halls -> display rows, joined on the hall code.
  // The backend lists every hall; halls with no points and no participants are left out.
  function hallRows(payloadHalls, registryHalls) {
    var index = hallIndex(registryHalls);
    var list = Array.isArray(payloadHalls)
      ? payloadHalls.filter(function (h) {
        return isObject(h) && text(h.code) && (num(h.points) > 0 || num(h.participants) > 0);
      })
      : [];
    var rows = list.map(function (h) {
      var code = text(h.code);
      var style = hallStyle(index, code);
      return {
        code: code,
        label: style.label,
        group: style.group,
        color: style.color,
        onColor: style.onColor,
        rank: h.rank,
        points: num(h.points),
        participants: num(h.participants),
        submissions: num(h.submissions)
      };
    });
    if (rows.length && rows.every(hasValidRank)) return rows;
    rows.sort(function (a, b) { return b.points - a.points || a.label.localeCompare(b.label); });
    return competitionRanks(rows);
  }

  // Student rows gain their hall's colours for the badge and the progress bar.
  function withHallColours(rows, registryHalls) {
    var index = hallIndex(registryHalls);
    return rows.map(function (r) {
      var style = hallStyle(index, r.hall);
      return Object.assign({}, r, { hallColor: style.color, hallOnColor: style.onColor });
    });
  }

  // Filter buttons: 'All halls' plus one per group, in registry order. Empty below 2 groups.
  function hallFilters(registryHalls) {
    var seen = [];
    (Array.isArray(registryHalls) ? registryHalls : []).forEach(function (h) {
      var g = isObject(h) ? text(h.group) : '';
      if (g && seen.indexOf(g) < 0) seen.push(g);
    });
    if (seen.length < 2) return [];
    return [{ key: 'all', label: 'All halls' }].concat(seen.map(function (g) {
      return { key: g, label: groupLabel(g) };
    }));
  }

  // Rows for one filter. A group view is re-ranked within the group.
  function filterHalls(rows, key) {
    if (!key || key === 'all') return rows;
    return competitionRanks(rows.filter(function (r) { return r.group === key; }));
  }

  // Choices for the "My hall" picker, from the registry, in registry order.
  function hallOptions(registryHalls) {
    return (Array.isArray(registryHalls) ? registryHalls : []).filter(function (h) {
      return isObject(h) && text(h.code);
    }).map(function (h) {
      return { code: text(h.code), label: text(h.label) ? text(h.label) + ' (' + text(h.code) + ')' : text(h.code) };
    });
  }

  function participantsText(n) {
    var v = num(n);
    return formatNumber(v) + (v === 1 ? ' participant' : ' participants');
  }

  // The line under the "My hall" picker. null when no hall is chosen.
  function myHallText(rows, code) {
    if (!code) return null;
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.code === code) {
        return r.label + ' (' + r.code + ') is ranked ' + r.rank + ' of ' + list.length + ' with ' +
          formatNumber(r.points) + ' points from ' + participantsText(r.participants) + '.';
      }
    }
    return 'No points from this hall yet.';
  }

  Object.assign(api, {
    ROW_LIMIT: ROW_LIMIT,
    formatNumber: formatNumber,
    barPercent: barPercent,
    statTiles: statTiles,
    rankRows: rankRows,
    podiumSlots: podiumSlots,
    visibleRows: visibleRows,
    contrastRatio: contrastRatio,
    readableTextOn: readableTextOn,
    themeVars: themeVars,
    hallRows: hallRows,
    withHallColours: withHallColours,
    participantsText: participantsText,
    myHallText: myHallText,
    hallFilters: hallFilters,
    filterHalls: filterHalls,
    hallOptions: hallOptions
  });

  // ---------- section C: icons, layout, payloads, loading screens, the page view ----------

  // 'utensils-crossed' -> 'UtensilsCrossed'. Lucide 0.x keys its icons by PascalCase name.
  function iconKey(name) {
    return text(name).split(/[^A-Za-z0-9]+/).filter(Boolean).map(function (part) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join('');
  }

  function camel(attr) {
    if (attr === 'class') return 'className';
    return attr.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
  }

  // Lucide icon node ['svg', attrs, [children]] -> { tag, props, children } with React prop names.
  function iconTree(node) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') return null;
    var props = {};
    var attrs = isObject(node[1]) ? node[1] : {};
    Object.keys(attrs).forEach(function (k) { props[camel(k)] = attrs[k]; });
    var kids = Array.isArray(node[2]) ? node[2] : [];
    return { tag: node[0], props: props, children: kids.map(iconTree).filter(Boolean) };
  }

  // Every module the hub knows, in display order, with the place it goes.
  // Adding a module later (nameList, taskBoards, phaseSwitch, streakGrid, checklist):
  // add one row here, one entry in TABS if it needs a new tab, a line in layoutFor's
  // hasData, and one component in the MODULES map of hub-ui.js. Nothing else changes.
  var MODULE_PLACES = [
    ['stats', 'top'],
    ['prizes', 'top'],
    ['podium', 'rankings'],
    ['rankedList', 'rankings'],
    ['hallStandings', 'halls']
  ];
  var TABS = [
    { id: 'rankings', label: 'Rankings', icon: 'trophy' },
    { id: 'halls', label: 'Halls', icon: 'building-2' }
  ];

  // Which modules this challenge shows, given its descriptor and its loaded payload.
  // Unknown module names are ignored. A module whose data is absent is left out.
  function layoutFor(descriptor, payload) {
    var d = isObject(descriptor) ? descriptor : {};
    var p = isObject(payload) ? payload : {};
    var listed = Array.isArray(d.modules) ? d.modules : [];
    var hasData = {
      stats: true,
      prizes: !!text(d.prizes),
      podium: Array.isArray(p.students),
      rankedList: Array.isArray(p.students),
      hallStandings: Array.isArray(p.halls)
    };
    var top = [];
    var byTab = {};
    MODULE_PLACES.forEach(function (entry) {
      var name = entry[0];
      var place = entry[1];
      var wanted = name === 'stats' || listed.indexOf(name) >= 0;
      if (!wanted || !hasData[name]) return;
      if (place === 'top') top.push(name);
      else (byTab[place] = byTab[place] || []).push(name);
    });
    var tabs = TABS.filter(function (t) { return byTab[t.id]; }).map(function (t) {
      return { id: t.id, label: t.label, icon: t.icon, modules: byTab[t.id] };
    });
    return { top: top, tabs: tabs };
  }

  // The submit button: only while the challenge is live and its form link is usable.
  function submitLink(descriptor, state) {
    var f = isObject(descriptor) && isObject(descriptor.form) ? descriptor.form : null;
    if (state !== 'live' || !f) return null;
    var url = safeUrl(f.url);
    if (!url) return null;
    return { url: url, label: text(f.label) || 'Submit' };
  }

  // One browser storage key per payload. The API URL is part of it, so a moved
  // backend never shows another backend's saved results.
  function cacheKey(apiUrl, route, id) {
    return 'glc:v1:' + route + ':' + (id || '') + '@' + apiUrl;
  }

  var MESSAGES = {
    config: 'The hub could not read its settings file (config.json).',
    noapi: 'The results server address is not set yet.',
    network: 'Could not reach the results server. Check your connection and try again.',
    timeout: 'The results server did not answer in time.',
    parse: 'The results server sent something the hub cannot read.',
    server: 'The results server reported a problem.',
    missing: 'We could not find that challenge.',
    unknown: 'Something went wrong.'
  };

  // Error value -> the sentence shown on the page. A server message is shown as given.
  function errorText(error) {
    var e = isObject(error) ? error : {};
    // not_found: the registry lists the challenge but its results are not published yet.
    if (e.kind === 'server' && e.code === 'not_found') return 'The results for this challenge are not published yet. Try again in a few minutes.';
    if (e.kind === 'server' && text(e.message)) return text(e.message);
    if (e.kind === 'http') return 'The results server answered with an error (HTTP ' + num(e.status) + ').';
    return MESSAGES[e.kind] || MESSAGES.unknown;
  }

  // Parsed JSON for one route -> { ok: true, payload } or { ok: false, error }.
  function checkPayload(json, route, id) {
    if (!isObject(json)) return { ok: false, error: { kind: 'parse' } };
    if (json.ok === false) {
      var err = isObject(json.error) ? json.error : {};
      return { ok: false, error: { kind: 'server', code: text(err.code), message: text(err.message) } };
    }
    if (json.ok !== true || json.api !== 1) return { ok: false, error: { kind: 'parse' } };
    if (route === 'registry' && !Array.isArray(json.challenges)) return { ok: false, error: { kind: 'parse' } };
    if (route === 'challenge' && (json.id !== id || !isObject(json.totals))) return { ok: false, error: { kind: 'parse' } };
    return { ok: true, payload: json };
  }

  // entry: { payload, fromCache, loading, slow, error } as kept by hub-app.js.
  // -> { screen: 'skeleton' | 'slow' | 'error' | 'data', note: null | 'refreshing' | 'refresh-failed' }
  function screenFor(entry) {
    var e = isObject(entry) ? entry : {};
    if (e.payload) {
      if (e.loading && e.fromCache) return { screen: 'data', note: 'refreshing' };
      if (e.error) return { screen: 'data', note: 'refresh-failed' };
      return { screen: 'data', note: null };
    }
    if (e.error) return { screen: 'error', note: null };
    return { screen: e.slow ? 'slow' : 'skeleton', note: null };
  }

  function savedText(payload) {
    var when = isObject(payload) ? formatStamp(payload.updatedAt || payload.generatedAt) : '';
    return when ? 'Showing saved results, last changed ' + when + '.' : 'Showing saved results.';
  }

  // Spec section 7: syncedAt null or more than 30 minutes old while a challenge is live.
  function scoresDelayed(syncedAt, nowMs, state) {
    if (state !== 'live') return false;
    var ms = typeof syncedAt === 'string' ? Date.parse(syncedAt) : NaN;
    if (!isFinite(ms)) return true;
    return nowMs - ms > TIMING.staleSyncMinutes * 60 * 1000;
  }

  // Everything the challenge page shows, as plain data. hub-ui.js only renders this.
  function challengeView(descriptor, payload, registry, nowMs) {
    var d = isObject(descriptor) ? descriptor : {};
    var p = isObject(payload) ? payload : {};
    var regHalls = isObject(registry) ? registry.halls : [];
    var state = deriveState(d, todayInDubai(nowMs), p.final === true);
    var rows = withHallColours(rankRows(p.students), regHalls);
    var halls = hallRows(p.halls, regHalls);
    return {
      id: d.id,
      name: text(d.name) || 'Challenge',
      tagline: text(d.tagline),
      icon: text(d.icon) || 'leaf',
      state: state,
      badge: badgeText(state, d.startDate),
      dates: formatRange(d.startDate, d.endDate),
      theme: themeVars(d.theme),
      prizes: text(d.prizes),
      layout: layoutFor(d, p),
      stats: statTiles(p.totals),
      rows: rows,
      maxPoints: rows.reduce(function (m, r) { return Math.max(m, r.points); }, 0),
      halls: halls,
      maxHallPoints: halls.reduce(function (m, r) { return Math.max(m, r.points); }, 0),
      hallFilters: hallFilters(regHalls),
      hallOptions: hallOptions(regHalls),
      empty: emptyText(state, d.startDate),
      form: submitLink(d, state),
      updated: formatStamp(p.updatedAt)
    };
  }

  Object.assign(api, {
    MODULE_PLACES: MODULE_PLACES,
    TABS: TABS,
    iconKey: iconKey,
    iconTree: iconTree,
    layoutFor: layoutFor,
    submitLink: submitLink,
    cacheKey: cacheKey,
    errorText: errorText,
    checkPayload: checkPayload,
    screenFor: screenFor,
    savedText: savedText,
    scoresDelayed: scoresDelayed,
    challengeView: challengeView
  });

  return api;
});
