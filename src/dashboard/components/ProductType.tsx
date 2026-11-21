import { useState } from 'react';
import { api, type Site } from '../lib/api';
import { Code } from './Code';
import { SettingsCard } from './setup/kit';
import { Note, toast } from './ui';
import { hasApp } from '../../shared/platform';

/**
 * Product types (src/worker/product-type.ts, docs/GUIDE.md "Product types"): the type picker in Settings, the type
 * icon on Home, and the event snippets for an extension and a newsletter.
 */

export type ProductType = 'website' | 'app' | 'extension' | 'newsletter';
export type MetricKey = 'installs' | 'weekly_active' | 'uninstalls' | 'subscribers' | 'new_subscribers' | 'unsubscribes' | 'opens';

/** An extension's or a newsletter's numbers, as /api/home and GET /api/sites/:id/product send them. */
export interface ProductNumbers {
  type: 'extension' | 'newsletter';
  headline: MetricKey;
  metrics: { key: MetricKey; label: string; value: number; previous: number; change_pct: number | null }[];
}

export const TYPE_LABEL: Record<ProductType, string> = { website: 'Website', app: 'iOS app', extension: 'Browser extension', newsletter: 'Newsletter' };

/** What each tile counts, for its tooltip. */
export const METRIC_NOTE: Record<MetricKey, string> = {
  installs: 'Install events in this period. The extension sends one from chrome.runtime.onInstalled.',
  weekly_active: 'Browsers that sent install or active in the 7 days up to the end of this period, against the 7 days before.',
  uninstalls: 'Uninstall events in this period, sent by the page Chrome opens after an uninstall.',
  subscribers: 'Every subscribe minus every unsubscribe up to the end of this period, against the start of it.',
  new_subscribers: 'Subscribe events in this period.',
  unsubscribes: 'Unsubscribe events in this period.',
  opens: 'Open events in this period. Each open counts, so one reader can open twice.',
};

/** The site's type: the one picked in Settings, else app with a bundle id, else website (productType in the Worker). */
export function typeOf(site: Pick<Site, 'app_bundle_id' | 'android_package'> & { product_type?: string | null }): ProductType {
  const t = site.product_type;
  return t === 'website' || t === 'app' || t === 'extension' || t === 'newsletter' ? t : hasApp(site) ? 'app' : 'website';
}

export const headlineOf = (p: ProductNumbers) => p.metrics.find((m) => m.key === p.headline)!;

/** The Overview's tiles per type, in order, before the numbers arrive (TYPE_METRICS in the Worker). */
export const TYPE_TILES: Record<'extension' | 'newsletter', { key: MetricKey; label: string }[]> = {
  extension: [
    { key: 'installs', label: 'Installs' },
    { key: 'weekly_active', label: 'Weekly active' },
    { key: 'uninstalls', label: 'Uninstalls' },
  ],
  newsletter: [
    { key: 'subscribers', label: 'Subscribers' },
    { key: 'new_subscribers', label: 'New subscribers' },
    { key: 'unsubscribes', label: 'Unsubscribes' },
    { key: 'opens', label: 'Opens' },
  ],
};

/** Fewer is better for these. */
export const DOWN_IS_GOOD = new Set<MetricKey>(['uninstalls', 'unsubscribes']);

/** A small glyph per type, in the same rounded square as the app icon on Home. */
export function TypeGlyph({ type, size }: { type: 'extension' | 'newsletter' | 'app'; size: number }) {
  const s = Math.round(size * 0.62);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600"
      style={{ width: size, height: size }}
      role="img"
      aria-label={TYPE_LABEL[type]}
      title={TYPE_LABEL[type]}
    >
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {type === 'extension' ? (
          // A puzzle piece.
          <path d="M10 4.5a2 2 0 1 1 4 0V6h3.5A1.5 1.5 0 0 1 19 7.5V11h-1.5a2 2 0 1 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 1 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V15h1.5a2 2 0 1 0 0-4H5V7.5A1.5 1.5 0 0 1 6.5 6H10z" />
        ) : type === 'newsletter' ? (
          // An envelope.
          <>
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
            <path d="m4 7 8 6 8-6" />
          </>
        ) : (
          // A phone.
          <>
            <rect x="7" y="3" width="10" height="18" rx="2.2" />
            <path d="M11 17.5h2" />
          </>
        )}
      </svg>
    </span>
  );
}

/** The goal names each type sends, for Settings and the docs. */
export const TYPE_EVENTS: Record<'extension' | 'newsletter', { name: string; when: string }[]> = {
  extension: [
    { name: 'install', when: 'once, when Chrome installs the extension' },
    { name: 'active', when: 'once a day while the browser runs' },
    { name: 'uninstall', when: 'from the page Chrome opens after an uninstall' },
  ],
  newsletter: [
    { name: 'subscribe', when: 'a new subscriber' },
    { name: 'unsubscribe', when: 'a subscriber leaves' },
    { name: 'open', when: 'a subscriber opens an issue' },
  ],
};

/** The background script of a Manifest V3 extension that sends install and active (docs/GUIDE.md "Product types"). */
export function extensionSnippet(siteId: string, origin: string, domain: string) {
  return `// background.js, Manifest V3. Needs the "storage" and "alarms" permissions.
const HOST = '${origin}';
const SITE = '${siteId}';

async function send(name) {
  let { fdId } = await chrome.storage.local.get('fdId');
  if (!fdId) await chrome.storage.local.set({ fdId: (fdId = crypto.randomUUID()) });
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await fetch(HOST + '/api/event', {
    method: 'POST',
    body: JSON.stringify({ w: SITE, t: 'goal', n: name, u: 'https://${domain}/extension', vid: fdId, sid: fdId + '-' + day }),
  });
}

// One active a day: weekly active counts browsers with install or active in the last 7 days.
async function active() {
  const today = new Date().toISOString().slice(0, 10);
  const { fdDay } = await chrome.storage.local.get('fdDay');
  if (fdDay === today) return;
  await chrome.storage.local.set({ fdDay: today });
  await send('active');
}

chrome.runtime.onInstalled.addListener((e) => {
  if (e.reason === 'install') send('install');
  chrome.runtime.setUninstallURL('https://${domain}/uninstalled');
});
chrome.runtime.onStartup.addListener(active);
chrome.alarms.create('fd-active', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(active);`;
}

/** The page Chrome opens after an uninstall, on the site's domain, with the FounderData script in its head. */
export const uninstallSnippet = `<!-- https://your-domain/uninstalled, with the FounderData script tag in <head> -->
<script>window.addEventListener('load', () => window.founderdata('goal', 'uninstall'));</script>`;

/** Server code a newsletter tool's webhook calls (docs/GUIDE.md "Product types"). */
export function newsletterSnippet(siteId: string, origin: string, domain: string) {
  return `// Runs on your server or a Worker. Call it from your newsletter tool's webhook.
async function track(name, subscriberId) {
  const vid = String(subscriberId).replace(/[^\\w-]/g, '').slice(0, 40).padEnd(8, '0');
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await fetch('${origin}/api/event', {
    method: 'POST',
    // FounderData drops requests without a browser-like user agent as bots.
    headers: { 'user-agent': 'newsletter-relay/1.0' },
    body: JSON.stringify({ w: '${siteId}', t: 'goal', n: name, u: 'https://${domain}/', vid, sid: vid + '-' + day }),
  });
}

// New subscriber:   await track('subscribe', subscriber.id)
// Unsubscribed:     await track('unsubscribe', subscriber.id)
// Opened an issue:  await track('open', subscriber.id)`;
}

/** The snippet and event list for an extension or a newsletter. Nothing for a website or an app. */
export function TypeSetup({ site, type, origin }: { site: Site; type: ProductType; origin: string }) {
  if (type !== 'extension' && type !== 'newsletter') return null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-[13px] text-stone-500">
        {type === 'extension' ? 'The extension sends three goal events to the event API, so it needs no other tracker.' : 'Your newsletter tool sends three goal events through a webhook to the event API.'}
      </p>
      <ul className="space-y-1 text-[13px] text-stone-500">
        {TYPE_EVENTS[type].map((e) => (
          <li key={e.name}>
            <code className="rounded bg-stone-100 px-1">{e.name}</code> {e.when}
          </li>
        ))}
      </ul>
      <Code>{type === 'extension' ? extensionSnippet(site.id, origin, site.domain) : newsletterSnippet(site.id, origin, site.domain)}</Code>
      {type === 'extension' && <Code>{uninstallSnippet.replace('your-domain', site.domain)}</Code>}
      <Note
        more={
          <p>
            The URL in <code className="rounded bg-stone-100 px-1">u</code> must be on {site.domain}. docs/GUIDE.md, Product types, has the details.
          </p>
        }
      >
        The URL in <code className="rounded bg-stone-100 px-1">u</code> must be on {site.domain}.
      </Note>
    </div>
  );
}

/** Settings, "Product type": what the site is, which picks the numbers it leads with. */
export function ProductTypeSection({ site, onSaved }: { site: Site & { product_type?: string | null }; onSaved?: (type: string | null) => void }) {
  const [type, setType] = useState<ProductType>(typeOf(site));
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: string }>({});
  const origin = window.location.origin;

  async function pick(next: ProductType) {
    if (next === type) return;
    setState({ busy: true });
    try {
      const d = await api<{ type: ProductType; product_type: string | null }>(`/api/sites/${site.id}/type`, { method: 'PUT', json: { type: next } });
      setType(d.type);
      setState({});
      toast(`Saved. ${TYPE_LABEL[d.type]} numbers lead on Overview and Home.`, 'ok');
      onSaved?.(d.product_type);
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }

  const options: ProductType[] = ['website', 'app', 'extension', 'newsletter'];
  return (
    <SettingsCard
      id="product-type"
      title="Product type"
      desc="The type picks the numbers this site leads with. An extension shows installs, weekly active and uninstalls. A newsletter shows subscribers, new subscribers, unsubscribes and opens. Neither shows bounce rate or session time."
    >
      <div>
        <div className="seg flex-wrap" role="group" aria-label="Product type">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className="whitespace-nowrap"
              aria-pressed={type === o}
              disabled={state.busy || (o === 'app' && !hasApp(site))}
              title={o === 'app' && !hasApp(site) ? "Add the app's bundle id or package name under General first" : undefined}
              onClick={() => pick(o)}
            >
              {TYPE_LABEL[o]}
            </button>
          ))}
        </div>
      </div>
      {state.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
      {(type === 'extension' || type === 'newsletter') && (
        <div className="mt-4">
          <TypeSetup site={site} type={type} origin={origin} />
        </div>
      )}
    </SettingsCard>
  );
}
