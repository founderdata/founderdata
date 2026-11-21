import type { ReactNode } from 'react';
import { navigate } from '../../App';
import { isViewer } from '../../lib/api';
import { isPro } from '../../lib/pro';
import { HomeLink } from '../Logo';
import { ProSlot } from '../ProSlot';
import { phoneLink } from './HomeHeader';
import { SupportButton } from '../Support';
import { ThemeToggle } from '../ThemeToggle';
import { StickyBar } from '../ui';

const link = 'inline-flex h-9 items-center rounded-[10px] px-3 text-[13px] font-medium transition-colors duration-fast';

/**
 * The bar on top of All apps, Dashboards, Mail, Notifications and Needs you: the logo, the deployment-wide pages with the current one marked,
 * and `children` (a period control) before the theme and support buttons. It stays on top from sm up, like Home's.
 */
export function PageBar({ current, children }: { current: 'apps' | 'notifications' | 'mail' | 'dashboards' | 'needsYou'; children?: ReactNode }) {
  const pages = [
    { key: 'home', label: 'All sites', to: '/' },
    { key: 'apps', label: 'All apps', to: '/apps' },
    // Dashboards is a Pro page that viewers read too: a core build reaches its Pro card from the command palette.
    ...(isPro ? [{ key: 'dashboards', label: 'Dashboards', to: '/dashboards' }] : []),
    // Mail is the owner's, and a Pro page: a core build reaches its Pro card from the command palette.
    ...(isViewer() || !isPro ? [] : [{ key: 'mail', label: 'Mail', to: '/mail' }]),
    ...(isViewer() ? [] : [{ key: 'notifications', label: 'Notifications', to: '/notifications' }]),
  ];
  return (
    <StickyBar>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-3">
        <HomeLink />
        <nav className="ml-1 flex items-center gap-0.5 sm:ml-3" aria-label="Main">
          {pages.slice(0, 1).map(pageButton)}
          {/* Needs you (FounderData Pro), with its count. Core draws nothing here. */}
          {!isViewer() && (
            <ProSlot
              name="needsYouLink"
              current={current === 'needsYou'}
              className={`${link} hidden sm:inline-flex ${current === 'needsYou' ? 'bg-stone-100 text-ink' : 'text-stone-500 hover:bg-stone-100 hover:text-ink'}`}
            />
          )}
          {pages.slice(1).map(pageButton)}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {/* On phones the page links hide, so Needs you keeps a button of its own (not on its own page). */}
          {!isViewer() && current !== 'needsYou' && <ProSlot name="needsYouLink" className={phoneLink.replace('md:hidden', 'sm:hidden')} />}
          {children}
          <ThemeToggle small />
          <span className="hidden sm:contents">
            <SupportButton compact />
          </span>
        </div>
      </div>
    </StickyBar>
  );

  function pageButton(p: (typeof pages)[number]) {
    return (
      <button
        key={p.key}
        aria-current={p.key === current ? 'page' : undefined}
        className={`${link} ${p.key === current ? 'bg-stone-100 text-ink' : 'text-stone-500 hover:bg-stone-100 hover:text-ink'} ${p.key === 'home' ? '' : p.key === current ? 'hidden sm:inline-flex' : 'hidden sm:inline-flex'}`}
        onClick={() => navigate(p.to)}
      >
        {p.key === 'home' ? (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mr-1.5 sm:hidden">
              <path d="M10 3 5 8l5 5" />
            </svg>
            {p.label}
          </>
        ) : (
          p.label
        )}
      </button>
    );
  }
}
