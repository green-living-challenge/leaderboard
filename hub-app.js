/* GLC hub: state, data loading and page assembly. Paints saved results at once,
   refreshes in the background, and sends the anonymous visit log (visit log spec).
   It stores nothing else it was not given, except the My page token. */
(function () {
  'use strict';

  var root = document.getElementById('root');

  function startupFailed() {
    root.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'shell-main';
    p.setAttribute('role', 'alert');
    p.textContent = 'The page could not start. Reload to try again.';
    root.appendChild(p);
  }

  if (!window.React || !window.ReactDOM || !window.htm || !window.GLCLogic || !window.GLCData || !window.GLCUI) {
    startupFailed();
    return;
  }

  var h = React.createElement;
  var html = htm.bind(h);
  var L = window.GLCLogic;
  var D = window.GLCData;
  var UI = window.GLCUI;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useCallback = React.useCallback;
  var useRef = React.useRef;

  var store = D.safeStorage(function () { return window.localStorage; });
  var API_KEY = 'glc:v1:api';
  var CSV_KEY = 'glc:v1:csv';
  var MY_HALL_KEY = 'glc:v1:myHall';
  var DIVISION_KEY = 'glc:v1:division';
  var FALLBACK_NAME = 'Green Living Challenge';
  var DEVICE_KEY = 'glc:v1:device';
  var ME_KEY = 'glc:v1:me';
  var SIGNIN_KEY = 'glc:v1:signin';
  var ME_SETTLED = ['ready', 'empty', 'invalid', 'error'];

  function remembered(key) {
    var v = store.get(key);
    return typeof v === 'string' && v ? v : null;
  }

  // The visit log (visit log spec, section 3): this visit's channel tag, read once and removed
  // from the address so that a copied link does not repeat it, the device ID, and the host of
  // the page the visitor came from.
  var visitInfo = (function () {
    var href = window.location.href;
    var clean = L.withoutSource(href);
    if (clean !== null) {
      try {
        window.history.replaceState(window.history.state, '', clean);
      } catch (e) {
        // The address keeps its tag; the page works the same.
      }
    }
    return {
      source: L.readSource(href),
      device: D.deviceId(store, DEVICE_KEY, window.crypto),
      referrer: L.referrerHost(document.referrer, window.location.hostname)
    };
  })();

  // My page (My page spec, section 4): the sign-in code the door sent back ('#/me?code=...'),
  // read once and removed from the address before anything else, so it is never copied along.
  var arrivedCode = (function () {
    var href = window.location.href;
    var code = L.readCode(href);
    var clean = L.withoutCode(href);
    if (clean !== null) {
      try {
        window.history.replaceState(window.history.state, '', clean);
      } catch (e) {
        // The address keeps its code; the page works the same.
      }
    }
    return code;
  })();

  // config.json -> the API address, the public copy's published link and the sign-in door's
  // address. All three are remembered, so a repeat visit can start before config.json has answered.
  function useConfig() {
    var s = useState({ loading: true, api: remembered(API_KEY), csv: remembered(CSV_KEY), signin: remembered(SIGNIN_KEY), error: null });
    var state = s[0];
    var setState = s[1];
    var a = useState(0);
    var attempt = a[0];
    var setAttempt = a[1];
    useEffect(function () {
      var cancelled = false;
      setState(function (prev) { return { loading: true, api: prev.api, csv: prev.csv, signin: prev.signin, error: null }; });
      D.loadConfig(window.fetch.bind(window), window.location.href).then(function (res) {
        if (cancelled) return;
        if (res.ok) {
          store.set(API_KEY, res.api);
          store.set(CSV_KEY, res.csv);
          store.set(SIGNIN_KEY, res.signin);
          setState({ loading: false, api: res.api, csv: res.csv, signin: res.signin, error: null });
        } else {
          setState(function (prev) {
            return { loading: false, api: prev.api, csv: prev.csv, signin: prev.signin, error: prev.api ? null : res.error };
          });
        }
      });
      return function () { cancelled = true; };
    }, [attempt]);
    var retry = useCallback(function () { setAttempt(function (n) { return n + 1; }); }, []);
    return [state, retry];
  }

  // One payload: the saved copy at once, then a fresh one in the background, read
  // from the public copy first and the API second (D.loadPayload). gid is the
  // challenge's tab in the public copy. wait holds the fresh read back until the
  // registry has answered, so a challenge opened from a link learns its tab first.
  // skipCopy(), if given, is asked once as each read starts: a read already under
  // way is never restarted because its answer changed.
  // Returns [entry, retry]. entry: { key, payload, fromCache, loading, slow, error, source } or null,
  // where source ('copy' or 'api') says where the last fresh payload came from.
  function useResource(config, route, id, gid, wait, skipCopy) {
    var api = config.api;
    var csv = config.csv || null;
    var key = api && (route === 'registry' || id) ? L.cacheKey(api, route, id) : null;
    var s = useState(null);
    var entry = s[0];
    var setEntry = s[1];
    var a = useState(0);
    var attempt = a[0];
    var setAttempt = a[1];
    useEffect(function () {
      if (!key) {
        setEntry(null);
        return undefined;
      }
      var cancelled = false;
      var saved = store.get(key);
      var savedPayload = saved && L.checkPayload(saved.payload, route, id).ok ? saved.payload : null;
      var shown = entry && entry.key === key && entry.payload ? entry.payload : savedPayload;
      setEntry(function (prev) {
        var same = prev && prev.key === key;
        var payload = (same && prev.payload) || savedPayload;
        return { key: key, payload: payload, fromCache: !!payload, loading: true, slow: false, error: null,
          source: same ? prev.source : undefined };
      });
      if (wait) return function () { cancelled = true; };
      var slowTimer = setTimeout(function () {
        setEntry(function (e) { return e && e.key === key && e.loading ? Object.assign({}, e, { slow: true }) : e; });
      }, L.TIMING.slowMs);
      D.loadPayload({
        api: api, csv: csv, route: route, id: id, gid: skipCopy && skipCopy() ? null : gid, base: window.location.href,
        fetchImpl: window.fetch.bind(window),
        check: function (json) { return L.checkPayload(json, route, id); },
        copyMs: L.TIMING.copyMs, giveUpMs: L.TIMING.giveUpMs
      }).then(function (res) {
        clearTimeout(slowTimer);
        if (cancelled) return;
        var checked = res.ok ? L.checkPayload(res.json, route, id) : { ok: false, error: res.error };
        if (checked.ok) {
          var payload = L.newerPayload(shown, checked.payload);
          store.set(key, { savedAt: Date.now(), payload: payload });
          setEntry({ key: key, payload: payload, fromCache: false, loading: false, slow: false, error: null, source: res.source });
        } else {
          setEntry(function (e) {
            return Object.assign({}, e, { key: key, loading: false, slow: false, error: checked.error });
          });
        }
      });
      return function () {
        cancelled = true;
        clearTimeout(slowTimer);
      };
    }, [key, attempt, csv, gid, wait]);
    var retry = useCallback(function () { setAttempt(function (n) { return n + 1; }); }, []);
    return [entry && entry.key === key ? entry : null, retry];
  }

  function useHash() {
    var s = useState(L.parseHash(window.location.hash));
    useEffect(function () {
      function onHash() { s[1](L.parseHash(window.location.hash)); }
      window.addEventListener('hashchange', onHash);
      return function () { window.removeEventListener('hashchange', onHash); };
    }, []);
    return s[0];
  }

  // My page: { state, page, error }. With a code in the address it is exchanged for the token,
  // which is the only thing kept on the device; with a token on the device the page is fetched;
  // with neither the page is signed out. active: whether the page is showing.
  function useMe(config, active) {
    var api = config.api;
    // The arrived code is held until its exchange settles, so Try again after a failed request reuses it.
    var codeRef = useRef(arrivedCode);
    arrivedCode = '';
    var s = useState({ state: codeRef.current ? 'exchanging' : (remembered(ME_KEY) ? 'loading' : 'signed-out'), page: null, error: null });
    var me = s[0];
    var setMe = s[1];
    var a = useState(0);
    var attempt = a[0];
    var setAttempt = a[1];
    useEffect(function () {
      if (!active || !api) return undefined;
      var code = codeRef.current;
      var token = remembered(ME_KEY);
      if (!code && !token) {
        setMe({ state: 'signed-out', page: null, error: null });
        return undefined;
      }
      var cancelled = false;
      setMe(function (prev) {
        if (code) return { state: 'exchanging', page: null, error: null };
        // A page already shown for a token stays while a fresh one is fetched.
        return prev.state === 'ready' && prev.page ? prev : { state: 'loading', page: null, error: null };
      });
      D.loadMe({ api: api, code: code, token: code ? '' : token, base: window.location.href,
        fetchImpl: window.fetch.bind(window), timeoutMs: L.TIMING.giveUpMs }).then(function (res) {
        if (cancelled) return;
        var next = res.ok ? L.checkMe(res.json) : { state: 'error', error: res.error };
        if (code) {
          if (next.state === 'ready' && !next.token) next = { state: 'error', error: { kind: 'parse' } };
          // A settled exchange replaces whatever token this device held: the new one, or none.
          if (next.state !== 'error') {
            codeRef.current = '';
            store.set(ME_KEY, next.token || null);
          }
        } else if (next.state === 'invalid') {
          store.set(ME_KEY, null);
        }
        setMe(function (prev) {
          // A refresh that failed keeps the page it had.
          if (!code && next.state === 'error' && prev.state === 'ready' && prev.page) return prev;
          // held: the device keeps a token, so the empty card offers Forget me instead of a new sign-in.
          return { state: next.state, page: next.page || null, error: next.error || null, held: !!remembered(ME_KEY) };
        });
      });
      return function () { cancelled = true; };
    }, [active, api, attempt]);
    var retry = useCallback(function () { setAttempt(function (n) { return n + 1; }); }, []);
    var forget = useCallback(function () {
      store.set(ME_KEY, null);
      setMe({ state: 'signed-out', page: null, error: null });
    }, []);
    return [me, retry, forget];
  }

  function App() {
    var c = useConfig();
    var config = c[0];
    var retryConfig = c[1];
    var route = useHash();
    var isMe = route.view === 'me';
    var m = useMe(config, isMe);
    var me = m[0];
    var retryMe = m[1];
    var forgetMe = m[2];
    var hallState = useState(function () {
      var v = store.get(MY_HALL_KEY);
      return typeof v === 'string' ? v : '';
    });
    var tabState = useState(null);
    var divisionState = useState(function () {
      var v = store.get(DIVISION_KEY);
      return typeof v === 'string' ? v : '';
    });

    var r = useResource(config, 'registry', null, 0, false);
    var registryEntry = r[0];
    var retryRegistry = r[1];
    var registry = registryEntry && registryEntry.payload;
    var nowMs = Date.now();
    var today = L.todayInDubai(nowMs);
    var selectedId = route.id || (registry ? L.pickDefault(registry, today) : null);
    var descriptor = registry && selectedId ? L.findChallenge(registry, selectedId) : null;
    // With a public copy, a challenge waits until the registry, which names its tab, has answered.
    // A challenge read that starts after the registry had to come from the API skips the copy too.
    var registryAnswered = !!(registryEntry && (registryEntry.payload || registryEntry.error));
    var registryFromApi = useRef(false);
    registryFromApi.current = !!(registryEntry && registryEntry.source === 'api');
    var ch = useResource(config, 'challenge', selectedId, config.csv && descriptor ? descriptor.csvGid : null,
      !!config.csv && !registryAnswered, function () { return registryFromApi.current; });
    var challengeEntry = ch[0];
    var retryChallenge = ch[1];
    var payload = challengeEntry && challengeEntry.payload;
    // The visit log: one track function for every event, reading the challenge shown when it is
    // called. One visit per page load, once the API address is known, and one error per failed load.
    var shown = useRef(null);
    shown.current = selectedId;
    var api = config.api;
    var track = useCallback(function (event, detail) {
      if (!api) return;
      D.sendTrack(D.buildTrackUrl(api, {
        e: event, d: detail || '', c: shown.current || '', s: visitInfo.source,
        r: event === 'visit' ? visitInfo.referrer : '', v: visitInfo.device, m: L.screenKind(window.innerWidth)
      }, window.location.href), window.fetch.bind(window));
    }, [api]);
    var visitSent = useRef(false);
    useEffect(function () {
      if (!api || visitSent.current) return;
      visitSent.current = true;
      track('visit');
    }, [api]);
    var registryFailure = registryEntry && registryEntry.error ? L.errorDetail('registry', registryEntry.error) : '';
    var challengeFailure = challengeEntry && challengeEntry.error ? L.errorDetail('challenge', challengeEntry.error) : '';
    useEffect(function () { if (registryFailure) track('error', registryFailure); }, [registryFailure]);
    useEffect(function () { if (challengeFailure) track('error', challengeFailure); }, [challengeFailure]);
    var meSettled = isMe && ME_SETTLED.indexOf(me.state) !== -1 ? me.state : '';
    useEffect(function () { if (meSettled) track('me', meSettled); }, [meSettled]);
    function forget() { track('forget'); forgetMe(); }
    var program = registry && registry.program ? registry.program : {};
    var programName = typeof program.name === 'string' && program.name.trim() ? program.name.trim() : FALLBACK_NAME;
    var division = registry ? L.pickDivision(divisionState[0], hallState[0], registry.halls) : '';
    var view = descriptor ? L.challengeView(descriptor, payload, registry, nowMs, division, programName) : null;
    var theme = view ? view.theme : L.themeVars(null);
    var themeClasses = view ? view.themeClasses : L.themeClasses(null);
    // The browser chrome follows the challenge theme only once a challenge shows; before that,
    // and on error pages, the header and the chrome keep the program's maroon.
    useEffect(function () {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', view ? theme['--glc-from'] : '#4A1526');
    }, [view ? theme['--glc-from'] : '']);

    useEffect(function () { tabState[1](null); }, [selectedId]);
    useEffect(function () {
      document.title = isMe ? 'My page | ' + programName : (view ? view.name + ' | ' + programName : programName);
    }, [isMe, view && view.name, programName]);

    function setDivision(key) {
      divisionState[1](key);
      store.set(DIVISION_KEY, key);
    }
    // A division pill. The switch that follows a My hall choice goes through setDivision and is not counted.
    function chooseDivision(key) {
      if (key !== division) track('division', key);
      setDivision(key);
    }
    function chooseTab(id) {
      if (id !== tabState[0]) track('tab', id);
      tabState[1](id);
    }
    function setMyHall(code) {
      hallState[1](code);
      store.set(MY_HALL_KEY, code);
      if (code) track('hall', code);
      var group = L.groupOfHall(registry ? registry.halls : [], code);
      if (group) setDivision(group);
    }
    function retryAll() {
      retryRegistry();
      retryChallenge();
    }

    var form = view && registry ? view.form : null;
    var signinUrl = L.signinAddress(config.signin);
    var main;
    var regScreen = L.screenFor(registryEntry);
    if (isMe && config.api) {
      main = html`<${UI.MePage} me=${me} view=${me.page ? L.meView(me.page, registry ? registry.halls : []) : null}
        signinUrl=${signinUrl} inApp=${L.inAppBrowser(navigator.userAgent)} form=${form}
        onForget=${forget} onRetry=${retryMe} track=${track} />`;
    } else if (!config.api && config.error) {
      main = html`<${UI.ErrorCard} message=${L.errorText(config.error)} onRetry=${retryConfig} />`;
    } else if (!config.api || regScreen.screen === 'skeleton' || regScreen.screen === 'slow') {
      main = html`<${UI.Skeleton} slow=${regScreen.screen === 'slow'} />`;
    } else if (regScreen.screen === 'error') {
      main = html`<${UI.ErrorCard} message=${L.errorText(registryEntry.error)} onRetry=${retryRegistry} />`;
    } else if (!selectedId) {
      main = html`<p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-700">There are no challenges to show yet.</p>`;
    } else if (!descriptor) {
      main = html`<${UI.ErrorCard} title="Challenge not found" message=${L.errorText({ kind: 'missing' })} />`;
    } else {
      var chScreen = L.screenFor(challengeEntry);
      var notes = [];
      if (chScreen.note === 'refreshing') {
        notes.push(html`<${UI.Notice} key="saved" text=${L.savedText(payload) + ' Checking for updates.'} />`);
      } else if (chScreen.note === 'refresh-failed') {
        notes.push(html`<${UI.Notice} key="failed" tone="warn"
          text=${L.savedText(payload) + ' Could not refresh: ' + L.errorText(challengeEntry.error)} onRetry=${retryAll} />`);
      }
      if (!registryEntry.fromCache && L.scoresDelayed(registry.syncedAt, nowMs, view.state)) {
        notes.push(html`<${UI.Notice} key="delayed" tone="warn" text="Scores may be delayed." />`);
      }
      var body;
      if (chScreen.screen === 'data') {
        body = html`<${UI.ChallengeBody} view=${view} tab=${tabState[0]} setTab=${chooseTab}
          myHall=${hallState[0]} setMyHall=${setMyHall} division=${division} setDivision=${chooseDivision} track=${track} />`;
      } else if (chScreen.screen === 'error') {
        body = html`<${UI.ErrorCard} message=${L.errorText(challengeEntry.error)} onRetry=${retryChallenge} />`;
      } else {
        body = html`<${UI.Skeleton} slow=${chScreen.screen === 'slow'} />`;
      }
      main = html`<${UI.Hero} view=${view} />${notes}${body}`;
    }

    var groups = registry ? L.groupChallenges(registry, today) : { current: [], past: [] };
    var myPage = signinUrl ? (isMe ? { href: '#/', label: 'Results', icon: 'trophy' } : { href: '#/me', label: 'My page', icon: 'user' }) : null;
    return html`
      <div className=${'glc-root ' + themeClasses + (view ? ' glc-themed' : '') + (form ? ' pb-28' : '')} style=${theme}>
        <${UI.ShellHeader} programName=${programName} myPage=${myPage}>
          <${UI.Switcher} groups=${groups} selectedId=${selectedId} track=${track} />
        <//>
        <main className="mx-auto max-w-3xl px-4 pt-4 pb-8">${main}</main>
        <${UI.Footer} updated=${view && payload ? view.updated : ''} org=${typeof program.org === 'string' ? program.org : ''}
          guideUrl=${L.safeUrl(program.guideUrl)} whatsappUrl=${L.safeUrl(program.whatsappUrl)} contactEmail=${L.contactAddress(program.contactEmail)}
          myPage=${myPage} track=${track} />
        <${UI.SubmitBar} form=${form} guideUrl=${L.safeUrl(program.guideUrl)} track=${track} />
      </div>`;
  }

  // A render error shows a message instead of a blank page.
  class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      if (this.state.failed) {
        return html`<p role="alert" className="shell-main">Something went wrong while showing the results. Reload to try again.</p>`;
      }
      return this.props.children;
    }
  }

  try {
    ReactDOM.createRoot(root).render(html`<${Boundary}><${App} /><//>`);
  } catch (e) {
    startupFailed();
  }
})();
