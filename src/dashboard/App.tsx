import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { RouteFallback, type FallbackKind } from './components/ui/RouteFallback';
import { api, setRole } from './lib/api';
import { checkSession, isPublicPath } from './lib/boot';
import { afterRoute, navigate } from './lib/nav';
import { Pages, Palette } from './lib/pages';
import { warmWhenIdle } from './lib/prefetch';
import { RouteBoundary } from './lib/RouteBoundary';
import { kindOf, matchRoute } from './lib/routes';

// Pages import navigate from here, so it stays exported from App; it lives in lib/nav.ts.
export { navigate };

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  const [auth, setAuth] = useState<boolean | null>(null);
  // True once a teammate has an account: the login screen then asks for a name or email.
  const [team, setTeam] = useState(false);
  const signedIn = useRef(false);

  // The role decides which controls the pages show (setRole, isViewer in lib/api.ts).
  const check = () =>
    checkSession().then(
      (r) => {
        setRole(r.role ?? 'admin');
        setTeam(!!r.team);
        signedIn.current = r.loggedIn;
        setAuth(r.loggedIn);
      },
      () => setAuth(false),
    );

  useEffect(() => {
    // A share or invite link needs no session, so it asks nothing.
    if (!isPublicPath(window.location.pathname)) check();
    const out = () => {
      setAuth(false);
      // /api/auth/me names `team` only to a signed-out caller. A tab that was signed in kept the answer it got then, so
      // its sign-in form had no "Name or email" field and a teammate could not sign in after a logout. Ask again once.
      if (!signedIn.current) return;
      signedIn.current = false;
      api<{ team?: boolean }>('/api/auth/me').then(
        (r) => setTeam(!!r.team),
        () => undefined,
      );
    };
    window.addEventListener('ml:logout', out);
    return () => window.removeEventListener('ml:logout', out);
  }, []);

  // A new page starts at the top; back and forward return to where you were.
  useLayoutEffect(() => {
    afterRoute();
  }, [path]);
  useEffect(() => {
    if (auth) warmWhenIdle(window.location.pathname);
  }, [auth]);

  // A share link needs no login (src/worker/share.ts).
  const share = /^\/share\/([\w-]+)\/?$/.exec(path);
  if (share) return <Page kind="plain"><Pages.SharePage token={share[1]} /></Page>;
  // An invite link: the person picks a password (pro/worker/team.ts).
  const join = /^\/join\/([0-9a-f]{64})\/?$/.exec(path);
  if (join) return <Page kind="plain"><Pages.Join token={join[1]} onDone={() => { navigate('/'); check(); }} /></Page>;
  // The skeleton of the page being opened holds the screen until the session check answers.
  const route = matchRoute(path);
  if (auth === null) return <RouteFallback kind={kindOf(route)} />;
  if (!auth) return <Page kind="login"><Pages.Login onLogin={check} team={team} /></Page>;
  return (
    <>
      <Page kind={kindOf(route)}>
        <Routes path={path} />
      </Page>
      <PaletteHost />
    </>
  );
}

function Page({ kind, children }: { kind: FallbackKind; children: ReactNode }) {
  const path = usePath();
  return (
    <RouteBoundary path={path}>
      <Suspense fallback={<RouteFallback kind={kind} />}>{children}</Suspense>
    </RouteBoundary>
  );
}

function Routes({ path }: { path: string }) {
  const route = matchRoute(path);
  switch (route.page) {
    case 'apps':
      return <Pages.Apps />;
    case 'mail':
      return <Pages.Mail />;
    case 'needsYou':
      return <Pages.NeedsYou />;
    case 'dashboards':
      return <Pages.Dashboards id={route.id} />;
    case 'notifications':
      return <Pages.Notifications />;
    case 'live':
      return <Pages.Live />;
    case 'getStarted':
      return <Pages.GetStarted />;
    // Keyed by site: useApi keeps the last answer while a new URL loads, which suits a period change and would show one
    // site's numbers under another site's name on a site switch.
    case 'settings':
      return <Pages.Settings key={route.siteId} siteId={route.siteId} />;
    case 'dashboard':
      return <Pages.Dashboard key={route.siteId} siteId={route.siteId} view={route.view} />;
    default:
      return <Pages.Home />;
  }
}

// The palette opens with the keyboard or the toolbar's Search button. The shell listens for both and loads the
// palette on the first one, so the shortcut answers at once and the palette's code downloads only for people who use it.
function PaletteOpened() {
  // The palette listens for this event once it has mounted; the keystroke that loaded it is already gone. Effects of
  // a child run before its parent's, so the listener exists by the time this fires.
  useEffect(() => {
    window.dispatchEvent(new Event('fd:palette'));
  }, []);
  return <Palette />;
}

function PaletteHost() {
  const [wanted, setWanted] = useState(false);
  const wantedRef = useRef(false);
  useEffect(() => {
    const want = () => {
      wantedRef.current = true;
      setWanted(true);
    };
    const key = (e: KeyboardEvent) => {
      if (wantedRef.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        want();
      }
    };
    const show = () => !wantedRef.current && want();
    window.addEventListener('keydown', key);
    window.addEventListener('fd:palette', show);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('fd:palette', show);
    };
  }, []);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <PaletteOpened />
    </Suspense>
  );
}
