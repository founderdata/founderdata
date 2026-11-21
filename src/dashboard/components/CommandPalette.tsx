import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { isViewer, type Site } from '../lib/api';
import { isPro, proUi } from '../lib/pro';
import { ALL_VIEWS, SECTION_LABELS, sectionState, sectionUrl } from '../lib/sections';
import { setThemePref } from '../lib/theme';
import { useApi } from '../lib/useApi';
import { SiteIcon } from './Icons';
import { PERIODS } from './Toolbar';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

const glyph = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
/** An icon per group, for rows that bring none of their own. */
const GROUP_ICON: Record<string, ReactNode> = {
  Period: glyph('M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'),
  'Go to': glyph('M5 12h14M13 6l6 6-6 6'),
  Theme: glyph('M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z'),
};
const SECTION_ICON = glyph('M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z');

/** The label with the typed text in bold, so the eye finds why a row matched. */
function Marked({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-ink">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/** Sets the period in the URL; useQueryState reads it back on popstate. */
function setPeriod(period: string) {
  const p = new URLSearchParams(window.location.search);
  p.set('period', period);
  p.delete('from');
  p.delete('to');
  p.delete('granularity');
  window.history.replaceState(null, '', `${window.location.pathname}?${p}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * ⌘K (Ctrl K elsewhere), or the toolbar's Search button: jump to a site, one of its sections, a period, another page
 * or a theme by typing a few letters. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const { data: sites } = useApi<Site[]>(open ? '/api/sites' : null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener('fd:palette', show);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('fd:palette', show);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setText('');
      setAt(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const path = window.location.pathname;
    const current = sites?.find((s) => path.startsWith(`/site/${s.id}`));
    const onData = path === '/' || (!!current && !path.endsWith('/settings'));
    const out: Item[] = [];
    if (current)
      // Every section, as in the section row. One the site has not set up opens its setup step.
      for (const v of ALL_VIEWS)
        out.push({
          id: `sec-${v}`,
          group: current.name,
          label: SECTION_LABELS[v],
          hint: !isPro && v !== 'overview' ? 'Pro' : sectionState(current, v).muted ? 'Not set up' : undefined,
          run: () => navigate(sectionUrl(current.id, v)),
        });
    for (const s of sites ?? [])
      out.push({
        id: `site-${s.id}`,
        group: 'Sites and apps',
        label: s.name,
        hint: s.domain.endsWith('.invalid') ? s.app_bundle_id ?? undefined : s.domain,
        icon: <SiteIcon domain={s.domain} app={!!s.app_bundle_id} size={16} />,
        run: () => navigate(`/site/${s.id}${window.location.search}`),
      });
    if (onData) for (const p of PERIODS) out.push({ id: `p-${p.value}`, group: 'Period', label: p.label, run: () => setPeriod(p.value) });
    out.push({ id: 'go-home', group: 'Go to', label: 'All sites and apps', run: () => navigate('/') });
    if (current) out.push({ id: 'go-settings', group: 'Go to', label: `${current.name} settings and install`, run: () => navigate(`/site/${current.id}/settings`) });
    if (!isViewer()) out.push({ id: 'go-alerts', group: 'Go to', label: 'Notifications and alerts', run: () => navigate('/notifications') });
    out.push({ id: 'go-apps', group: 'Go to', label: 'Connected apps', hint: isPro ? undefined : 'Pro', run: () => navigate('/apps') });
    out.push({ id: 'go-dashboards', group: 'Go to', label: 'Dashboards', hint: isPro ? undefined : 'Pro', run: () => navigate('/dashboards') });
    if (!isViewer() && proUi?.slots.needsYouPage) out.push({ id: 'go-needs-you', group: 'Go to', label: 'Needs you', run: () => navigate('/needs-you') });
    if (!isViewer()) out.push({ id: 'go-mail', group: 'Go to', label: 'Mail', hint: isPro ? undefined : 'Pro', run: () => navigate('/mail') });
    for (const t of ['system', 'light', 'dark'] as const)
      out.push({ id: `t-${t}`, group: 'Theme', label: t === 'system' ? 'Follow the system' : t === 'light' ? 'Light' : 'Dark', run: () => setThemePref(t) });
    return out;
  }, [sites, open]);

  const needle = text.trim().toLowerCase();
  // Labels that start with the typed text come first, then labels that contain it, then hints and group names.
  const shown = useMemo(() => {
    if (!needle) return items;
    const rank = (i: Item) => {
      const l = i.label.toLowerCase();
      if (l.startsWith(needle)) return 0;
      if (l.split(/\s+/).some((w) => w.startsWith(needle))) return 1;
      if (l.includes(needle)) return 2;
      return `${i.hint ?? ''} ${i.group}`.toLowerCase().includes(needle) ? 3 : -1;
    };
    return items
      .map((i, n) => ({ i, n, r: rank(i) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.n - b.n)
      .map((x) => ({ ...x.i, group: needle ? 'Results' : x.i.group }));
  }, [items, needle]);
  const pick = Math.min(at, Math.max(0, shown.length - 1));

  useEffect(() => {
    // Scroll the list only; scrollIntoView would move the page behind the overlay too.
    const box = list.current;
    const el = box?.querySelector<HTMLElement>('[data-active="true"]');
    if (!box || !el) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop - 8;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 8;
  }, [pick]);

  if (!open) return null;
  const run = (i: Item | undefined) => {
    if (!i) return;
    setOpen(false);
    i.run();
  };
  let group = '';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-stone-900/25 p-4 pt-[12vh] backdrop-blur-[6px] dark:bg-black/60"
      style={{ animation: 'fd-fade var(--dur-fast) var(--ease-out) both' }}
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="pop w-full max-w-[600px] overflow-hidden !rounded-2xl shadow-overlay"
        style={{ animation: 'fd-dialog-in var(--dur-slow) var(--ease-spring) both' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="flex items-center gap-3 border-b border-stone-200/70 px-4">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="shrink-0 text-stone-400" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="fd-palette-list"
            aria-activedescendant={shown[pick] ? `fd-cmd-${shown[pick].id}` : undefined}
            aria-label="Find a site, section, period or setting"
            className="h-14 w-full bg-transparent text-[15px] outline-none placeholder:text-stone-400"
            placeholder="Find a site, section, period or setting"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) (e.preventDefault(), setAt((a) => (a + 1) % Math.max(1, shown.length)));
              else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) (e.preventDefault(), setAt((a) => (a - 1 + shown.length) % Math.max(1, shown.length)));
              else if (e.key === 'Home') (e.preventDefault(), setAt(0));
              else if (e.key === 'End') (e.preventDefault(), setAt(shown.length - 1));
              else if (e.key === 'Enter') run(shown[pick]);
              else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div ref={list} id="fd-palette-list" role="listbox" aria-label="Results" className="relative max-h-[min(52vh,440px)] overflow-y-auto overscroll-contain p-1.5">
          {shown.length === 0 && (
            <div className="px-3 py-10 text-center">
              <div className="text-sm text-ink">Nothing matches "{text}"</div>
              <div className="mt-1 text-xs text-stone-400">Try a site name, a section such as SEO, or a period such as 7 days.</div>
            </div>
          )}
          {shown.map((i, n) => {
            const head = i.group !== group ? (group = i.group) : null;
            const active = n === pick;
            return (
              <div key={i.id}>
                {head && <div className="px-2.5 pb-1.5 pt-3 text-micro uppercase text-stone-400 first:pt-1.5">{head}</div>}
                <button
                  id={`fd-cmd-${i.id}`}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  data-active={active}
                  className="group/item relative flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm text-stone-600 data-[active=true]:bg-stone-100 data-[active=true]:text-ink dark:data-[active=true]:bg-stone-200/70"
                  onMouseMove={() => n !== pick && setAt(n)}
                  onClick={() => run(i)}
                >
                  <span className="flex w-4 shrink-0 justify-center text-stone-400 group-data-[active=true]/item:text-ink">{i.icon ?? (i.id.startsWith('sec-') ? SECTION_ICON : GROUP_ICON[i.id.startsWith('p-') ? 'Period' : i.id.startsWith('t-') ? 'Theme' : 'Go to'])}</span>
                  <span className="truncate">
                    <Marked text={i.label} needle={needle} />
                  </span>
                  {i.hint && <span className="ml-auto truncate pl-3 text-xs text-stone-400">{i.hint}</span>}
                  <span className={`kbd shrink-0 ${i.hint ? 'ml-2' : 'ml-auto'} opacity-0 group-data-[active=true]/item:opacity-100`} aria-hidden="true">↵</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-stone-200/70 bg-stone-50/60 px-4 py-2 text-xs text-stone-400">
          <span className="flex items-center gap-1.5"><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
          <span className="flex items-center gap-1.5"><span className="kbd">↵</span> to open</span>
          <span className="ml-auto hidden items-center gap-1.5 sm:flex"><span className="kbd">{mac ? '⌘' : 'Ctrl'}</span><span className="kbd">K</span> to close</span>
        </div>
      </div>
    </div>
  );
}
