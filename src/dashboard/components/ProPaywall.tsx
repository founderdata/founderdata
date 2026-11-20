import { useEffect, useRef, useState } from 'react';
import { amount, type Offer } from '../../shared/offer';
import { OFFER_PAGE } from '../../shared/product';
import { useOffer } from '../lib/offer';
import { PRO_APPS_PAGE, PRO_CARDS, PRO_DASHBOARDS_PAGE, PRO_MAIL_PAGE, PRO_SECTIONS } from '../lib/proFeatures';
import { matchRoute } from '../lib/routes';
import { PageBar } from './home/PageBar';
import { AFTER_PAYING, BuyLink, eur, InstallPrompt, priceOf, stepText } from './ProUpsell';
import './ProPaywall.css';

type Card = (typeof PRO_CARDS)[number][number];
const ALL_CARDS = [...PRO_CARDS[0], ...PRO_CARDS[1]];
/** The names a phone shows under the headline, before the price: one per area. */
const PHONE_NAMES = ['Subscriptions', 'App analytics', 'Meta ads', 'Search Console', 'AI visibility', 'Apple Search Ads', 'iPhone app', '39 MCP tools'];

function FeatureCard({ card: [group, name, line] }: { card: Card }) {
  return (
    <div className="fd-pw-card">
      <small>{group}</small>
      <h3>{name}</h3>
      <p>{line}</p>
    </div>
  );
}

/**
 * A column or strip of feature cards. A moving column draws its list twice so the loop is seamless; each list is
 * taller than the stage, so a card never shows twice at once. Still columns and the phone strip draw it once and
 * scroll by hand. Decorative: the same features are in a list for screen readers.
 */
function Stream({ cards, className, loop }: { cards: Card[]; className: string; loop: boolean }) {
  const list = (copy: number) => (
    <div className="fd-pw-list" key={copy}>
      {cards.map((c) => (
        <FeatureCard key={c[1]} card={c} />
      ))}
    </div>
  );
  return (
    <div className={className} aria-hidden="true">
      <div className="fd-pw-track">{loop ? [list(0), list(1)] : list(0)}</div>
    </div>
  );
}

/** The receipt: the price after launch, the launch saving, the total, this step's licenses and the pay button. */
function Receipt({ offer, onInstall }: { offer: Offer | null; onInstall: () => void }) {
  const launch = offer?.kind === 'launch' ? offer : null;
  const total = offer ? priceOf(offer) : null;
  return (
    <div className="fd-pw-panel">
      <div className="fd-pw-bar">
        <b data-live={launch ? '' : undefined}>{!offer ? '' : launch ? 'Launch price' : 'FounderData Pro'}</b>
        <span>No subscription</span>
      </div>
      <div className="fd-pw-in">
        {!offer ? (
          <div className="fd-pw-wait" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i className="fd-pw-wait-total" />
            <i className="fd-pw-wait-meter" />
          </div>
        ) : (
          <>
            {launch && (
              <>
                <div className="fd-pw-line">
                  <span>Price after launch</span>
                  <span>{eur(launch.regular)}</span>
                </div>
                <div className="fd-pw-line">
                  <span>Launch price saves</span>
                  <span className="fd-pw-g">−{eur(launch.saving)}</span>
                </div>
              </>
            )}
            <div className="fd-pw-line">
              <span>Updates</span>
              <span className="fd-pw-g">all of them, no renewal</span>
            </div>
            <div className="fd-pw-line">
              <span>All your sites and apps</span>
              <span className="fd-pw-g">no fee per site</span>
            </div>
            <div className="fd-pw-total">
              <span>You pay once</span>
              <div>
                <strong>{eur(total!)}</strong>
                <small>incl. VAT</small>
              </div>
            </div>
            {launch && (
              <>
                <div
                  className="fd-pw-meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={launch.seats}
                  aria-valuenow={launch.soldInStep}
                  aria-valuetext={`${launch.soldInStep} of ${launch.seats} sold at ${eur(launch.price)}, ${launch.leftInStep} left`}
                  aria-label="Licenses sold at this price"
                >
                  <i style={{ width: `${(launch.soldInStep / launch.seats) * 100}%` }} />
                </div>
                <div className="fd-pw-cap">
                  <strong>{stepText(launch)}</strong>
                  <span>
                    {eur(launch.next)} from license {launch.lastInStep + 1}
                  </span>
                </div>
              </>
            )}
          </>
        )}
        <BuyLink offer={offer} className="fd-pw-cta">
          {total === null ? 'Buy FounderData Pro' : `Buy Pro for ${eur(total)}`}
        </BuyLink>
        <p className="fd-pw-fine">{total === null ? 'Loading the price.' : `Or $${amount(total)}. Polar shows the final price before you pay.`}</p>
        <p className="fd-pw-links">
          <button type="button" onClick={onInstall}>
            Already bought? Install Pro
          </button>
          {launch && (
            <a href={OFFER_PAGE} target="_blank" rel="noreferrer">
              How this is counted
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

/** What a screen reader hears once the price is known. */
function announce(offer: Offer | null) {
  if (!offer) return '';
  if (offer.kind === 'regular') return `FounderData Pro costs ${eur(offer.regular)} incl. VAT, paid once.`;
  return `FounderData Pro costs ${eur(offer.price)} incl. VAT, paid once. ${stepText(offer)}.`;
}

/** Pauses the streams while the stage is off screen. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * What a core build shows in place of a FounderData Pro section: which report the tab holds, the live launch price as
 * a receipt, and Pro's features moving past on both sides. The stage is dark in both themes, one object that is the
 * same wherever it shows; the install card under it follows the theme.
 */
export function ProUpsellView() {
  const route = matchRoute(window.location.pathname);
  const section = route.page === 'dashboard' ? PRO_SECTIONS[route.view] : route.page === 'apps' ? PRO_APPS_PAGE : route.page === 'mail' ? PRO_MAIL_PAGE : route.page === 'dashboards' ? PRO_DASHBOARDS_PAGE : undefined;
  const o = useOffer();
  const offer = o.state === 'ready' ? o.offer : null;
  const [install, setInstall] = useState(false);
  const [held, setHeld] = useState(false);
  const installRef = useRef<HTMLDivElement>(null);
  const [stage, onScreen] = useOnScreen<HTMLElement>();
  const still = useReducedMotion();

  function openInstall() {
    setInstall(true);
    requestAnimationFrame(() => installRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  const view = (
    <div className="fd-pw-wrap">
      <section className="fd-pw" ref={stage} data-paused={!onScreen || held ? '' : undefined} data-still={still ? '' : undefined} aria-labelledby="fd-pw-title">
        <Stream cards={PRO_CARDS[0]} className="fd-pw-side fd-pw-up" loop={!still} />
        <div className="fd-pw-mid">
          <h2 id="fd-pw-title">
            {section?.title ?? 'This section'} is part of <em>FounderData Pro</em>
          </h2>
          {section && (
            <p className="fd-pw-lede">
              {section.body} {section.collected && <span>{section.collected}</span>}
            </p>
          )}
          <ul className="fd-pw-names" aria-label="Pro also adds">
            {PHONE_NAMES.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <Receipt offer={offer} onInstall={openInstall} />
          <p className="fd-pw-get">
            You get read access to the Pro repository on GitHub. Your AI agent merges it into your copy from a prompt here,
            and your own changes stay.
          </p>
          <p className="fd-pw-why">
            {offer?.kind === 'launch' && `The price rises in steps to ${eur(offer.regular)} from license ${offer.firstAfterLaunch}. `}
            Pro runs on your Cloudflare account, needs no license key, never contacts us and keeps working without us.
          </p>
          <p className="sr-only" aria-live="polite">
            {announce(offer)}
          </p>
        </div>
        <Stream cards={PRO_CARDS[1]} className="fd-pw-side fd-pw-down" loop={!still} />
        <Stream cards={ALL_CARDS} className="fd-pw-strip" loop={false} />
        {!still && (
          <button type="button" className="fd-pw-hold" onClick={() => setHeld((h) => !h)} aria-label={held ? 'Play the moving cards' : 'Pause the moving cards'}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              {held ? <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /> : <path d="M3 1.5h2v9H3zM7 1.5h2v9H7z" fill="currentColor" />}
            </svg>
          </button>
        )}
        <ul className="sr-only">
          {ALL_CARDS.map(([, name, line]) => (
            <li key={name}>
              {name}: {line}
            </li>
          ))}
        </ul>
      </section>

      <div ref={installRef} className="card mt-4 scroll-mt-32 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-[13px] text-stone-500">{AFTER_PAYING}</p>
          <button className="btn" onClick={() => setInstall((x) => !x)} aria-expanded={install}>
            {install ? 'Hide the install prompt' : 'Already bought? Install Pro'}
          </button>
        </div>
        {install && (
          <div className="mt-4">
            <InstallPrompt />
          </div>
        )}
      </div>
    </div>
  );
  // Connected apps and Dashboards are pages of their own, not sections inside the site dashboard, so they bring the page bar.
  if (route.page !== 'apps' && route.page !== 'dashboards') return view;
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-3 sm:px-6 sm:pt-4">
      <PageBar current={route.page} />
      <div className="mt-5 sm:mt-8">{view}</div>
    </div>
  );
}
