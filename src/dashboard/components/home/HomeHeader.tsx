import { useCallback, useRef, useState } from 'react';
import { navigate } from '../../App';
import { warmQuery } from '../../lib/prefetch';
import { isPro } from '../../lib/pro';
import { HomeLink } from '../Logo';
import { ProSlot } from '../ProSlot';
import { HeartIcon, showSupport, SupportDialog } from '../Support';
import { Check, ThemeToggle } from '../ThemeToggle';
import { Chevron, Dropdown, itemCls, MenuLabel, SearchButton } from '../Toolbar';
import { SegTrack, StickyBar } from '../ui';
import { PERIODS, useDismiss } from './shared';

/** The periods on the track; the rest sit in its More menu. */
const QUICK = ['today', '7d', '30d', '90d', '12m'];

export type PeriodOption = { value: string; label: string; short: string };

/**
 * The period as a sliding segmented control, the same one the site dashboard has: `quick` periods on the track, the
 * rest of `periods` in its More menu. Home's list by default; All apps passes its own.
 */
export function PeriodControl({
  period,
  onChange,
  className = '',
  periods = PERIODS,
  quick: quickList = QUICK,
}: {
  period: string;
  onChange: (p: string) => void;
  className?: string;
  periods?: PeriodOption[];
  quick?: string[];
}) {
  const QUICK = quickList;
  const PERIODS = periods;
  const quick = QUICK.includes(period);
  const label = PERIODS.find((p) => p.value === period)?.label ?? 'Last 30 days';
  return (
    <SegTrack className={`min-w-0 ${className}`} label="Period">
      {PERIODS.filter((p) => QUICK.includes(p.value)).map((p) => (
        <button key={p.value} aria-pressed={period === p.value} title={p.label} onMouseEnter={() => warmQuery({ period: p.value })} onFocus={() => warmQuery({ period: p.value })} onClick={() => onChange(p.value)}>
          {p.short}
        </button>
      ))}
      <Dropdown
        align="right"
        width="w-[200px]"
        button={
          <button aria-pressed={!quick} className="flex h-full items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[13px] font-medium text-stone-500 transition-colors duration-fast hover:text-ink aria-pressed:text-ink">
            {quick ? 'More' : label.replace('Last ', '')}
            <Chevron />
          </button>
        }
      >
        {(close) => (
          <>
            <MenuLabel>Period</MenuLabel>
            {PERIODS.filter((p) => !QUICK.includes(p.value)).map((p) => (
              <button
                key={p.value}
                className={itemCls(period === p.value)}
                onClick={() => {
                  close();
                  onChange(p.value);
                }}
              >
                {p.label}
                {period === p.value && <Check />}
              </button>
            ))}
          </>
        )}
      </Dropdown>
    </SegTrack>
  );
}

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 19.5c1.3-3.2 4-4.8 7.2-4.8s5.9 1.6 7.2 4.8" />
    </svg>
  );
}

/** Support and Log out, plus All apps, Mail and Notifications on narrow screens where the header has no room for them. */
function AccountMenu({ hasApps, viewer, onLogout }: { hasApps: boolean; viewer: boolean; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const item = itemCls(false);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn w-9 rounded-full px-0 text-stone-500 hover:text-ink" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} title="Account" onClick={() => setOpen((o) => !o)}>
        <PersonIcon />
      </button>
      {open && (
        <div role="menu" className="pop pop-in absolute right-0 top-full z-40 mt-1.5 w-56 origin-top-right p-1">
          {viewer && <MenuLabel>Read-only login</MenuLabel>}
          {hasApps && (
            <button role="menuitem" className={`${item} md:hidden`} onClick={pick(() => navigate('/apps'))}>
              All apps
            </button>
          )}
          {isPro && (
            <button role="menuitem" className={`${item} md:hidden`} onClick={pick(() => navigate('/dashboards'))}>
              Dashboards
            </button>
          )}
          {!viewer && isPro && (
            <button role="menuitem" className={`${item} md:hidden`} onClick={pick(() => navigate('/mail'))}>
              Mail
            </button>
          )}
          {!viewer && (
            <button role="menuitem" className={`${item} md:hidden`} onClick={pick(() => navigate('/notifications'))}>
              Notifications
            </button>
          )}
          {showSupport && (
            <button role="menuitem" className={item} onClick={pick(() => setSupport(true))}>
              <span className="text-revenue">
                <HeartIcon size={14} filled />
              </span>
              Support FounderData
            </button>
          )}
          <div className="my-1 border-t border-stone-200/70" role="separator" />
          <button role="menuitem" className={item} onClick={pick(onLogout)}>
            Log out
          </button>
        </div>
      )}
      <SupportDialog open={support} onClose={() => setSupport(false)} />
    </div>
  );
}

/** The Needs you button on phones, where the nav links sit in the account menu. */
export const phoneLink = 'btn gap-1.5 px-3 md:hidden';

const navLink = 'hidden h-9 items-center rounded-[10px] px-3 text-[13px] font-medium text-stone-500 transition-colors duration-fast hover:bg-stone-100 hover:text-ink md:inline-flex';

/**
 * The bar on top: logo and the two other pages on the left, the period and the account on the right. It stays on top
 * from sm up (StickyBar), so the period can change from anywhere down the page. A phone gets the period on its own row.
 */
export function HomeHeader({
  period,
  onPeriod,
  hasApps,
  viewer,
  showPeriod,
  onLogout,
}: {
  period: string;
  onPeriod: (p: string) => void;
  hasApps: boolean;
  viewer: boolean;
  showPeriod: boolean;
  onLogout: () => void;
}) {
  return (
    <StickyBar>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-3">
        {isPro && !viewer ? (
          // Pro's Needs you button needs the room on phones, so the logo drops its wordmark there.
          <>
            <span className="md:hidden">
              <HomeLink compact />
            </span>
            <span className="hidden md:contents">
              <HomeLink />
            </span>
          </>
        ) : (
          <HomeLink />
        )}
        <nav className="ml-3 hidden items-center gap-0.5 md:flex" aria-label="Main">
          {/* Needs you (FounderData Pro): the owner's open cards with their count. Core draws nothing here. */}
          {!viewer && <ProSlot name="needsYouLink" className={navLink} />}
          {hasApps && (
            <button className={navLink} onClick={() => navigate('/apps')}>
              All apps
            </button>
          )}
          {isPro && (
            <button className={navLink} onClick={() => navigate('/dashboards')}>
              Dashboards
            </button>
          )}
          {!viewer && isPro && (
            <button className={navLink} onClick={() => navigate('/mail')}>
              Mail
            </button>
          )}
          {!viewer && (
            <button className={navLink} onClick={() => navigate('/notifications')}>
              Notifications
            </button>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Phones keep the other pages in the account menu, so Needs you gets a button of its own. */}
          {!viewer && <ProSlot name="needsYouLink" className={phoneLink} />}
          {showPeriod && <PeriodControl period={period} onChange={onPeriod} className="hidden lg:inline-flex" />}
          <SearchButton />
          <ThemeToggle small />
          <AccountMenu hasApps={hasApps} viewer={viewer} onLogout={onLogout} />
        </div>
        {showPeriod && <PeriodControl period={period} onChange={onPeriod} className="w-full justify-between lg:hidden [&>*]:flex-1 [&>button]:px-1" />}
      </div>
    </StickyBar>
  );
}
