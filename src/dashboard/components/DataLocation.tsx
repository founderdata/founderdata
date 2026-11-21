import type { Site } from '../lib/api';
import { hasWebsite } from '../lib/siteKind';
import { CopyButton, Disclosure, SettingsCard } from './setup/kit';
import { useCardStatus } from './setup/status';
import { Note, toast } from './ui';
import { hasApp } from '../../shared/platform';

type Location = NonNullable<Site['data_location']>;

/** Where the D1 database sits, as a clause of the DPA paragraph. */
function storedClause(l: Location): string {
  if (l.jurisdiction === 'eu') return 'Cloudflare stores the data in a D1 database in the EU, under D1 jurisdiction eu.';
  if (l.jurisdiction === 'fedramp') return 'Cloudflare stores the data in a D1 database under D1 jurisdiction fedramp.';
  return 'Cloudflare stores the data in a D1 database that is not pinned to a region. Cloudflare placed it near where it was created.';
}

/**
 * The paragraph "Copy for DPA" puts on the clipboard, for a processing record or a DPA appendix. Every sentence states
 * what this deployment does (docs/PRIVACY.md): the region from DATA_JURISDICTION, the hashing in src/worker/collect.ts,
 * the retention from RETENTION_MONTHS and PII_RETENTION_MONTHS, and the tracker's cookie modes. Settings the server
 * can't see, such as whether a site turned on cookie mode, are stated as the condition they are.
 */
export function dpaText(site: Site, l: Location): string {
  const web = hasWebsite(site);
  const app = hasApp(site);
  const days = l.retention_days ?? 730;
  const out = [
    `${site.name} uses FounderData for analytics. We run it on our own Cloudflare account, so Cloudflare, Inc. is the only processor.`,
    storedClause(l),
    'A Cloudflare Worker handles each request in the data center nearest the visitor, which can be outside the EU.',
    'The Worker reads the IP address and user agent in memory and hashes them into a visitor id with HMAC-SHA256 and a salt that changes every day. It stores neither the IP address nor the full user agent.',
    'Country, region and city come from Cloudflare\'s lookup of the IP address. Browser, OS and device type come from the user agent.',
    `A daily job deletes visits, events and subscription signals older than ${days} days. Payment records stay for bookkeeping.`,
  ];
  if (l.pii_retention_days) {
    out.push(`The same job clears names and emails on payments older than ${l.pii_retention_days} days, and on visitor profiles with no visit in ${l.pii_retention_days} days.`);
  }
  if (web) {
    out.push(
      'The website tracker sets no cookies and writes nothing to the visitor\'s device by default.',
      'If the site turns on cookie mode after a visitor consents, the tracker keeps a random visitor id in the first-party cookie rt_vid for one year and a visit id in rt_sid for 30 minutes.',
      'A consent given through the tracker is kept in rt_consent for one year.',
    );
  }
  if (app) {
    out.push(
      'The iOS app makes a new random id on every launch and keeps one in the Keychain only after the user consents.',
      'If the app opts in to one id per install, it sends a hash of the identifier for vendor, never the raw value.',
    );
  }
  return out.join(' ');
}

/** Where the deployment keeps its data, and the DPA paragraph. One value for every site: the D1 database's jurisdiction. */
export function DataLocation({ site, location }: { site: Site; location: Location }) {
  const pinned = !!location.jurisdiction;
  const text = dpaText(site, location);
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${pinned ? 'bg-emerald-500' : 'bg-stone-300'}`} aria-hidden />
          Stored in: {location.stored}
        </div>
        <CopyButton value={text} label="Copy for DPA" className="btn h-8 text-xs" onCopied={() => toast('DPA paragraph copied', 'ok')} />
      </div>
      <Note
        more={
          <>
            <p>{location.processed}</p>
            {location.retention_days !== undefined && (
              <p>
                A daily job deletes visits and events after {location.retention_days} days.
                {location.pii_retention_days ? ` It clears names and emails after ${location.pii_retention_days} days.` : ''}
              </p>
            )}
            {!pinned && (
              <p>
                A new database created with <code className="whitespace-nowrap font-mono">npm run setup -- --jurisdiction eu</code> stays in the EU.{' '}
                <a className="underline underline-offset-2" href="https://github.com/founderdata/founderdata/blob/main/docs/PRIVACY.md#keep-the-database-in-the-eu" target="_blank" rel="noreferrer">
                  How the EU setting works
                </a>
              </p>
            )}
          </>
        }
      >
        {location.retention_days !== undefined ? `Requests run near the visitor. Data is deleted after ${location.retention_days} days.` : 'Requests run near the visitor.'}
      </Note>
      <Disclosure summary="Show the DPA paragraph">
        <p className="card-inset px-3.5 py-3 text-[13px] leading-relaxed text-stone-500">{text}</p>
      </Disclosure>
    </div>
  );
}

/** Settings, Data and privacy: the data location as its own card. */
export function DataLocationCard({ site }: { site: Site }) {
  const status = useCardStatus('data-location', site);
  if (!site.data_location) return null;
  return (
    <SettingsCard id="data-location" title="Data location" status={status} desc="One answer for every site: where the database sits and how long data stays.">
      <DataLocation site={site} location={site.data_location} />
    </SettingsCard>
  );
}
