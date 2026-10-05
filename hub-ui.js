/* GLC hub: React components, written with htm (no JSX, nothing compiled).
   Rendering only. Every decision comes from window.GLCLogic as plain data.
   Nothing here logs, and nothing is inserted as HTML: React escapes all text. */
(function () {
  'use strict';

  var h = React.createElement;
  var html = htm.bind(h);
  var L = window.GLCLogic;
  var useState = React.useState;

  // Module name -> component. hub-logic.js decides which names a challenge shows;
  // a name with no component here is skipped.
  var MODULES = {};

  // ---------- section 1: primitives, shell, loading and error states ----------

  function renderNode(tree, key) {
    return h(tree.tag, Object.assign({ key: key }, tree.props), tree.children.map(renderNode));
  }

  // Lucide 0.460.0 icon by registry name ('zap', 'utensils-crossed'). Unknown names show a leaf.
  function Icon(props) {
    var icons = window.lucide && window.lucide.icons ? window.lucide.icons : {};
    var tree = L.iconTree(icons[L.iconKey(props.name)] || icons.Leaf);
    if (!tree) return null;
    var p = Object.assign({}, tree.props, {
      className: props.className || 'w-5 h-5',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    return h(tree.tag, p, tree.children.map(renderNode));
  }

  function ShellHeader(props) {
    return html`
      <header className="shell-header">
        <div className="shell-inner flex items-center gap-2">
          <${Icon} name="leaf" className="w-5 h-5 shrink-0" />
          <p className="shell-title">${props.programName}</p>
        </div>
        ${props.children}
      </header>`;
  }

  function SwitcherLink(props) {
    var c = props.challenge;
    var selected = c.id === props.selectedId;
    var cls = 'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold ' +
      (selected ? 'border-white bg-white text-slate-900' : 'border-white/50 text-[#F5F0E8] hover:bg-white/10');
    return html`
      <li>
        <a href=${L.challengeHash(c.id)} aria-current=${selected ? 'page' : undefined} className=${cls}>
          <${Icon} name=${c.icon} className="w-4 h-4 shrink-0" />
          <span className="glc-name">${c.name}</span>
        </a>
      </li>`;
  }

  // groups: { current: [...], past: [...] } from GLCLogic.groupChallenges.
  function Switcher(props) {
    var current = props.groups.current;
    var past = props.groups.past;
    if (current.length + past.length < 2) return null;
    var pastSelected = past.some(function (c) { return c.id === props.selectedId; });
    return html`
      <nav aria-label="Challenges" className="shell-inner pt-0">
        ${current.length ? html`
          <ul className="flex flex-wrap gap-2">
            ${current.map(function (c) { return html`<${SwitcherLink} key=${c.id} challenge=${c} selectedId=${props.selectedId} />`; })}
          </ul>` : null}
        ${past.length ? html`
          <details className="mt-2" open=${pastSelected}>
            <summary className="cursor-pointer text-sm font-semibold">Past challenges (${past.length})</summary>
            <ul className="mt-2 flex flex-wrap gap-2">
              ${past.map(function (c) { return html`<${SwitcherLink} key=${c.id} challenge=${c} selectedId=${props.selectedId} />`; })}
            </ul>
          </details>` : null}
      </nav>`;
  }

  function Hero(props) {
    var v = props.view;
    return html`
      <section className="glc-hero rounded-2xl p-5 shadow-md" aria-labelledby="challenge-title">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-xl bg-white/15 p-2"><${Icon} name=${v.icon} className="w-7 h-7" /></div>
          <div className="min-w-0">
            <h1 id="challenge-title" className="glc-name text-2xl font-extrabold leading-tight">${v.name}</h1>
            ${v.dates ? html`<p className="mt-1 text-sm">${v.dates}</p>` : null}
          </div>
        </div>
        <p className="mt-3"><span className=${'glc-badge glc-badge-' + v.state}><span className="glc-dot" aria-hidden="true"></span>${v.badge}</span></p>
        ${v.tagline ? html`<p className="mt-3 text-sm">${v.tagline}</p>` : null}
      </section>`;
  }

  // tone: 'info' or 'warn'. onRetry adds a "Try again" button.
  function Notice(props) {
    var cls = 'mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-sm ' +
      (props.tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-700');
    return html`
      <div role="status" className=${cls}>
        <span>${props.text}</span>
        ${props.onRetry ? html`<button type="button" onClick=${props.onRetry} className="font-semibold underline">Try again</button>` : null}
      </div>`;
  }

  function Skeleton(props) {
    return html`
      <div aria-busy="true" className="mt-4">
        <p className="sr-only">Loading results</p>
        <div className="glc-pulse h-16 rounded-xl bg-slate-200"></div>
        <div className="glc-pulse mt-3 h-16 rounded-xl bg-slate-200"></div>
        <div className="glc-pulse mt-3 h-16 rounded-xl bg-slate-200"></div>
        ${props.slow ? html`<p role="status" className="mt-4 text-center text-sm text-slate-700">This can take a few more seconds.</p>` : null}
      </div>`;
  }

  function ErrorCard(props) {
    return html`
      <section role="alert" className="mt-4 rounded-2xl border border-red-200 bg-white p-5 text-center">
        <h2 className="text-lg font-bold text-slate-900">${props.title || 'Could not load results'}</h2>
        <p className="mt-2 text-sm text-slate-700">${props.message}</p>
        ${props.onRetry ? html`<button type="button" onClick=${props.onRetry} className="mt-4 rounded-lg bg-slate-900 px-5 py-2 font-semibold text-white">Try again</button>` : null}
      </section>`;
  }

  function StatsModule(props) {
    var tiles = props.view.stats;
    if (!tiles.length) return null;
    return html`
      <dl aria-label="Totals" className="grid gap-2" style=${{ gridTemplateColumns: 'repeat(' + tiles.length + ', minmax(0, 1fr))' }}>
        ${tiles.map(function (t) {
          return html`
            <div key=${t.key} className="flex flex-col-reverse rounded-xl border border-slate-200 bg-white p-3 text-center">
              <dt className="text-xs text-slate-600">${t.label}</dt>
              <dd className="m-0 text-xl font-extrabold text-slate-900">${t.value}</dd>
            </div>`;
        })}
      </dl>`;
  }
  MODULES.stats = StatsModule;

  // ARIA tabs: arrow keys move between tabs, only the active tab is in the tab order.
  function Tabs(props) {
    function onKey(e) {
      var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      var i = props.tabs.findIndex(function (t) { return t.id === props.active; });
      var next = props.tabs[(i + step + props.tabs.length) % props.tabs.length];
      props.onSelect(next.id);
      var el = document.getElementById('tab-' + next.id);
      if (el) el.focus();
    }
    return html`
      <div role="tablist" aria-label="Results" onKeyDown=${onKey} className="mt-5 grid gap-2"
        style=${{ gridTemplateColumns: 'repeat(' + props.tabs.length + ', minmax(0, 1fr))' }}>
        ${props.tabs.map(function (t) {
          var sel = t.id === props.active;
          var cls = 'flex items-center justify-center gap-2 rounded-xl px-3 py-2 font-semibold ' +
            (sel ? 'glc-accent shadow' : 'border border-slate-200 bg-white text-slate-700');
          return html`
            <button key=${t.id} id=${'tab-' + t.id} type="button" role="tab" aria-selected=${sel}
              aria-controls=${'panel-' + t.id} tabIndex=${sel ? 0 : -1} onClick=${function () { props.onSelect(t.id); }} className=${cls}>
              <${Icon} name=${t.icon} className="w-4 h-4" />${t.label}
            </button>`;
        })}
      </div>`;
  }

  function renderModule(name, props) {
    var C = MODULES[name];
    return C ? h(C, Object.assign({ key: name }, props)) : null;
  }

  // props: view (GLCLogic.challengeView), tab, setTab, myHall, setMyHall.
  function ChallengeBody(props) {
    var layout = props.view.layout;
    var tabs = layout.tabs.map(function (t) {
      return Object.assign({}, t, { modules: t.modules.filter(function (n) { return MODULES[n]; }) });
    }).filter(function (t) { return t.modules.length; });
    var active = tabs.some(function (t) { return t.id === props.tab; }) ? props.tab : (tabs[0] ? tabs[0].id : null);
    var many = tabs.length > 1;
    return html`
      <div className="mt-4 space-y-4">${layout.top.map(function (n) { return renderModule(n, props); })}</div>
      ${many ? html`<${Tabs} tabs=${tabs} active=${active} onSelect=${props.setTab} />` : null}
      ${tabs.filter(function (t) { return t.id === active; }).map(function (t) {
        return html`
          <div key=${t.id} id=${'panel-' + t.id} role=${many ? 'tabpanel' : undefined}
            aria-labelledby=${many ? 'tab-' + t.id : undefined} tabIndex=${many ? 0 : undefined}>
            ${t.modules.map(function (n) { return renderModule(n, props); })}
          </div>`;
      })}`;
  }

  function SubmitBar(props) {
    if (!props.form) return null;
    return html`
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/95 px-4 pt-3"
        style=${{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <a href=${props.form.url} target="_blank" rel="noopener noreferrer"
          className="glc-accent mx-auto flex max-w-3xl items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold shadow">
          <${Icon} name="send" className="w-5 h-5" />${props.form.label}<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>`;
  }

  function Footer(props) {
    return html`
      <footer className="mx-auto max-w-3xl px-4 py-6 text-center text-xs text-slate-600">
        ${props.updated ? html`<p>Results last changed ${props.updated} (Dubai time)</p>` : null}
        ${props.org ? html`<p className="mt-1">${props.org}</p>` : null}
        ${props.guideUrl ? html`<p className="mt-1"><a className="underline" href=${props.guideUrl} target="_blank" rel="noopener noreferrer">Green Living Guide</a></p>` : null}
      </footer>`;
  }

  // ---------- section 2: prizes, podium, ranked list, hall standings ----------

  function HallBadge(props) {
    if (!props.code) return null;
    return html`<span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
      style=${{ background: props.color, color: props.onColor }}>${props.code}</span>`;
  }

  function PrizesModule(props) {
    return html`
      <section aria-labelledby="prizes-title" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="shrink-0 rounded-lg bg-amber-100 p-2 text-amber-800"><${Icon} name="gift" /></div>
        <div className="min-w-0">
          <h2 id="prizes-title" className="font-bold text-amber-900">Prizes</h2>
          <p className="text-sm text-amber-900">${props.view.prizes}</p>
        </div>
      </section>`;
  }
  MODULES.prizes = PrizesModule;

  var PODIUM_STYLE = {
    1: { disc: 'bg-yellow-300 text-yellow-950', block: 'bg-yellow-200', height: '6rem' },
    2: { disc: 'bg-slate-300 text-slate-900', block: 'bg-slate-200', height: '4.5rem' },
    3: { disc: 'bg-amber-600 text-white', block: 'bg-amber-200', height: '3.5rem' }
  };

  function PodiumModule(props) {
    var slots = L.podiumSlots(props.view.rows);
    if (!slots.length) return null;
    return html`
      <section aria-labelledby="podium-title" className="mt-4">
        <h2 id="podium-title" className="sr-only">Top three</h2>
        <ol className="grid grid-cols-3 items-end gap-2">
          ${slots.map(function (s) {
            var st = PODIUM_STYLE[s.place];
            return html`
              <li key=${s.row.key} className="flex min-w-0 flex-col items-center text-center" style=${{ order: s.order }}>
                <span className=${'flex h-10 w-10 items-center justify-center rounded-full text-lg font-black ' + st.disc}>
                  <span className="sr-only">Rank </span>${s.row.rank}
                </span>
                <span className="glc-name mt-1 text-sm font-semibold text-slate-900">${s.row.name}</span>
                <${HallBadge} code=${s.row.hall} color=${s.row.hallColor} onColor=${s.row.hallOnColor} />
                <div className=${'mt-2 flex w-full flex-col items-center justify-end rounded-t-lg pb-2 ' + st.block} style=${{ height: st.height }}>
                  <span className="text-lg font-black text-slate-900">${L.formatNumber(s.row.points)}</span>
                  <span className="text-xs text-slate-700">points</span>
                </div>
              </li>`;
          })}
        </ol>
      </section>`;
  }
  MODULES.podium = PodiumModule;

  function RankedListModule(props) {
    var v = props.view;
    var state = useState(false);
    var expanded = state[0];
    var setExpanded = state[1];
    if (!v.rows.length) {
      return html`<p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-700">${v.empty}</p>`;
    }
    var rows = L.visibleRows(v.rows, expanded);
    return html`
      <section aria-labelledby="ranking-title" className="mt-4">
        <h2 id="ranking-title" className="text-lg font-bold text-slate-900">Full ranking</h2>
        <ol className="mt-2 space-y-2">
          ${rows.map(function (r) {
            return html`
              <li key=${r.key} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-white">
                  <span className="sr-only">Rank </span>${r.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="glc-name min-w-0 font-semibold text-slate-900">${r.name}</span>
                    <${HallBadge} code=${r.hall} color=${r.hallColor} onColor=${r.hallOnColor} />
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                    <div className="h-full rounded-full" style=${{ width: L.barPercent(r.points, v.maxPoints) + '%', background: r.hallColor }}></div>
                  </div>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block text-lg font-black text-slate-900">${L.formatNumber(r.points)}</span>
                  <span className="block text-xs text-slate-600">points</span>
                </span>
              </li>`;
          })}
        </ol>
        ${v.rows.length > L.ROW_LIMIT ? html`
          <button type="button" aria-expanded=${expanded} onClick=${function () { setExpanded(!expanded); }}
            className="mt-3 w-full rounded-xl border border-slate-300 bg-white py-2 font-semibold text-slate-800">
            ${expanded ? 'Show top ' + L.ROW_LIMIT : 'Show all ' + v.rows.length}
          </button>` : null}
      </section>`;
  }
  MODULES.rankedList = RankedListModule;

  function HallCard(props) {
    var r = props.row;
    return html`
      <li className="rounded-xl border-2 bg-white p-3" style=${{ borderColor: r.color }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-black" style=${{ background: r.color, color: r.onColor }}>
              <span className="sr-only">Rank </span>${r.rank}
            </span>
            <div className="min-w-0">
              <p className="glc-name font-bold text-slate-900">${r.label} <span className="font-normal text-slate-600">(${r.code})</span></p>
              <p className="text-xs text-slate-600">${L.participantsText(r.participants)}</p>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xl font-black text-slate-900">${L.formatNumber(r.points)}</p>
            <p className="text-xs text-slate-600">points</p>
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <div className="h-full rounded-full" style=${{ width: L.barPercent(r.points, props.max) + '%', background: r.color }}></div>
        </div>
      </li>`;
  }

  function HallStandingsModule(props) {
    var v = props.view;
    var state = useState('all');
    var filter = state[0];
    var setFilter = state[1];
    var rows = L.filterHalls(v.halls, filter);
    var mine = L.myHallText(v.halls, props.myHall);
    return html`
      <section aria-labelledby="halls-title" className="mt-4">
        <h2 id="halls-title" className="text-lg font-bold text-slate-900">Hall standings</h2>
        ${v.hallOptions.length ? html`
          <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">
            <label className="block text-sm font-semibold text-slate-800" htmlFor="my-hall">My hall</label>
            <select id="my-hall" value=${props.myHall || ''} onChange=${function (e) { props.setMyHall(e.target.value); }}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
              <option value="">Choose your hall</option>
              ${v.hallOptions.map(function (o) { return html`<option key=${o.code} value=${o.code}>${o.label}</option>`; })}
            </select>
            ${mine ? html`<p role="status" className="mt-2 text-sm text-slate-800">${mine}</p>` : null}
          </div>` : null}
        ${v.hallFilters.length ? html`
          <div role="group" aria-label="Show halls" className="mt-3 flex flex-wrap gap-2">
            ${v.hallFilters.map(function (f) {
              var on = f.key === filter;
              return html`
                <button key=${f.key} type="button" aria-pressed=${on} onClick=${function () { setFilter(f.key); }}
                  className=${'rounded-full border px-3 py-1 text-sm font-semibold ' + (on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800')}>
                  ${f.label}
                </button>`;
            })}
          </div>` : null}
        ${rows.length ? html`
          <ol className="mt-3 space-y-2">
            ${rows.map(function (r) { return html`<${HallCard} key=${r.code} row=${r} max=${v.maxHallPoints} />`; })}
          </ol>` : html`<p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-700">No hall points yet.</p>`}
      </section>`;
  }
  MODULES.hallStandings = HallStandingsModule;

  window.GLCUI = {
    Icon: Icon,
    ShellHeader: ShellHeader,
    Switcher: Switcher,
    Hero: Hero,
    Notice: Notice,
    Skeleton: Skeleton,
    ErrorCard: ErrorCard,
    ChallengeBody: ChallengeBody,
    SubmitBar: SubmitBar,
    Footer: Footer,
    MODULES: MODULES
  };
})();
