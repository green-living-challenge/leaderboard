/* GLC hub: state, data loading and page assembly. Paints saved results at once,
   refreshes in the background, and never logs or stores anything it was not given. */
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

  var store = D.safeStorage(function () { return window.localStorage; });
  var API_KEY = 'glc:v1:api';
  var MY_HALL_KEY = 'glc:v1:myHall';
  var FALLBACK_NAME = 'Green Living Challenge';

  function rememberedApi() {
    var v = store.get(API_KEY);
    return typeof v === 'string' && v ? v : null;
  }

  // config.json -> API address. The last good address is remembered so a repeat
  // visit can paint saved results before config.json has answered.
  function useConfig() {
    var initial = rememberedApi();
    var s = useState({ loading: true, api: initial, error: null });
    var state = s[0];
    var setState = s[1];
    var a = useState(0);
    var attempt = a[0];
    var setAttempt = a[1];
    useEffect(function () {
      var cancelled = false;
      setState(function (prev) { return { loading: true, api: prev.api, error: null }; });
      D.loadConfig(window.fetch.bind(window), window.location.href).then(function (res) {
        if (cancelled) return;
        if (res.ok) {
          store.set(API_KEY, res.api);
          setState({ loading: false, api: res.api, error: null });
        } else {
          setState(function (prev) { return { loading: false, api: prev.api, error: prev.api ? null : res.error }; });
        }
      });
      return function () { cancelled = true; };
    }, [attempt]);
    var retry = useCallback(function () { setAttempt(function (n) { return n + 1; }); }, []);
    return [state, retry];
  }

  // One payload: the saved copy at once, then a fresh copy in the background.
  // Returns [entry, retry]. entry: { key, payload, fromCache, loading, slow, error } or null.
  function useResource(api, route, id) {
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
      setEntry(function (prev) {
        var keep = prev && prev.key === key && prev.payload ? prev.payload : null;
        var payload = keep || savedPayload;
        return { key: key, payload: payload, fromCache: !!payload, loading: true, slow: false, error: null };
      });
      var slowTimer = setTimeout(function () {
        setEntry(function (e) { return e && e.key === key && e.loading ? Object.assign({}, e, { slow: true }) : e; });
      }, L.TIMING.slowMs);
      var url = D.buildUrl(api, route, id, window.location.href);
      D.fetchJson(url, { fetchImpl: window.fetch.bind(window), timeoutMs: L.TIMING.giveUpMs }).then(function (res) {
        clearTimeout(slowTimer);
        if (cancelled) return;
        var checked = res.ok ? L.checkPayload(res.json, route, id) : { ok: false, error: res.error };
        if (checked.ok) {
          store.set(key, { savedAt: Date.now(), payload: checked.payload });
          setEntry({ key: key, payload: checked.payload, fromCache: false, loading: false, slow: false, error: null });
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
    }, [key, attempt]);
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

  function App() {
    var c = useConfig();
    var config = c[0];
    var retryConfig = c[1];
    var route = useHash();
    var hallState = useState(function () {
      var v = store.get(MY_HALL_KEY);
      return typeof v === 'string' ? v : '';
    });
    var tabState = useState(null);

    var r = useResource(config.api, 'registry', null);
    var registryEntry = r[0];
    var retryRegistry = r[1];
    var registry = registryEntry && registryEntry.payload;
    var nowMs = Date.now();
    var today = L.todayInDubai(nowMs);
    var selectedId = route.id || (registry ? L.pickDefault(registry, today) : null);
    var ch = useResource(config.api, 'challenge', selectedId);
    var challengeEntry = ch[0];
    var retryChallenge = ch[1];

    var descriptor = registry && selectedId ? L.findChallenge(registry, selectedId) : null;
    var payload = challengeEntry && challengeEntry.payload;
    var view = descriptor ? L.challengeView(descriptor, payload, registry, nowMs) : null;
    var program = registry && registry.program ? registry.program : {};
    var programName = typeof program.name === 'string' && program.name.trim() ? program.name.trim() : FALLBACK_NAME;

    useEffect(function () { tabState[1](null); }, [selectedId]);
    useEffect(function () {
      document.title = view ? view.name + ' | ' + programName : programName;
    }, [view && view.name, programName]);

    function setMyHall(code) {
      hallState[1](code);
      store.set(MY_HALL_KEY, code);
    }
    function retryAll() {
      retryRegistry();
      retryChallenge();
    }

    var main;
    var regScreen = L.screenFor(registryEntry);
    if (!config.api && config.error) {
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
        body = html`<${UI.ChallengeBody} view=${view} tab=${tabState[0]} setTab=${tabState[1]}
          myHall=${hallState[0]} setMyHall=${setMyHall} />`;
      } else if (chScreen.screen === 'error') {
        body = html`<${UI.ErrorCard} message=${L.errorText(challengeEntry.error)} onRetry=${retryChallenge} />`;
      } else {
        body = html`<${UI.Skeleton} slow=${chScreen.screen === 'slow'} />`;
      }
      main = html`<${UI.Hero} view=${view} />${notes}${body}`;
    }

    var groups = registry ? L.groupChallenges(registry, today) : { current: [], past: [] };
    var form = view && registry ? view.form : null;
    return html`
      <${UI.ShellHeader} programName=${programName}>
        <${UI.Switcher} groups=${groups} selectedId=${selectedId} />
      <//>
      <main className=${'mx-auto max-w-3xl px-4 pt-4 ' + (form ? 'pb-28' : 'pb-8')}>${main}</main>
      <${UI.Footer} updated=${view && payload ? view.updated : ''} org=${typeof program.org === 'string' ? program.org : ''}
        guideUrl=${L.safeUrl(program.guideUrl)} />
      <${UI.SubmitBar} form=${form} />`;
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
