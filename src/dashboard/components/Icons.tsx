import { useState, type ReactNode } from 'react';
import { domainForSource } from '../../shared/sources';
import { flag } from '../lib/format';

/** The host part of "google.com/chrome" or "https://www.example.com/x", for /api/favicon. */
function iconHost(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#:].*$/, '');
}

/**
 * A domain's icon, fetched by this Worker (GET /api/favicon/:domain, src/worker/favicon.ts), so the browser never
 * sends a tracked or referring domain to anyone else. A 404 shows the fallback: a monochrome glyph, never an emoji.
 */
export function Favicon({ domain, size = 18, fallback }: { domain?: string | null; size?: number; fallback?: ReactNode }) {
  const [broken, setBroken] = useState(false);
  const host = domain ? iconHost(domain) : '';
  // An app-only site's placeholder domain (.invalid) and the reserved example domains (RFC 2606, the demo data) have no
  // icon to fetch, so they ask nothing and leave no 404 in the console.
  if (!host || broken || host.endsWith('.invalid') || /(^|\.)example\.(com|net|org)$/.test(host)) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded text-stone-400" style={{ width: size, height: size }}>
        {fallback ?? <LinkIcon size={Math.round(size * 0.85)} />}
      </span>
    );
  }
  return (
    <img
      src={`/api/favicon/${encodeURIComponent(host)}`}
      width={size}
      height={size}
      className="shrink-0 rounded"
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export function LinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

export function SourceIcon({ source, domain, size }: { source: string | null; domain?: string | null; size?: number }) {
  if (!source || source === 'Direct/None') return <Favicon size={size} />;
  return <Favicon domain={domainForSource(source) ?? domain ?? (source.includes('.') ? source : null)} size={size} />;
}

/**
 * The dashboard's own glyphs: 24-unit paths drawn with a 1.75 stroke in the text color, so they follow the theme and
 * look the same on every OS. They stand in where an emoji used to (channels, devices, platforms).
 */
const GLYPHS = {
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'm20 20-3.5-3.5'],
  chat: ['M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.3-4.3A7.5 7.5 0 1 1 20 11.5z'],
  sparkle: ['M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z', 'M19 16v4M17 18h4'],
  referral: ['M7 17 17 7', 'M9 7h8v8'],
  mail: ['M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V7A1.5 1.5 0 0 1 5 5.5z', 'm4 7 8 6 8-6'],
  paid: ['M3.5 10v4h3l7.5 4.5v-13L6.5 10z', 'M17.5 9a4 4 0 0 1 0 6'],
  phone: ['M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M11 18h2'],
  tablet: ['M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M11 18h2'],
  desktop: ['M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 20h8M12 16v4'],
  laptop: ['M6 5h12a1.5 1.5 0 0 1 1.5 1.5V15h-15V6.5A1.5 1.5 0 0 1 6 5z', 'M2.5 19h19'],
  globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z'],
  dot: ['M12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z'],
  filter: ['M4 5h16l-6.5 7.5V18l-3 1.5v-7z'],
} as const;
export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const CHANNEL_GLYPH: Record<string, GlyphName> = {
  Direct: 'link',
  'Organic Search': 'search',
  'Organic Social': 'chat',
  AI: 'sparkle',
  Referral: 'referral',
  Email: 'mail',
  Paid: 'paid',
};
export function ChannelIcon({ channel, size = 18 }: { channel: string | null; size?: number }) {
  return <Favicon size={size} fallback={<Glyph name={CHANNEL_GLYPH[channel ?? ''] ?? 'dot'} size={Math.round(size * 0.85)} />} />;
}

/** The icon of a site or app with no favicon of its own: an app gets the phone glyph, a website the link. */
export function SiteIcon({ domain, app, size = 18 }: { domain: string; app: boolean; size?: number }) {
  return <Favicon domain={domain} size={size} fallback={app ? <Glyph name="phone" size={Math.round(size * 0.85)} /> : undefined} />;
}

const BROWSER_DOMAINS: Record<string, string> = {
  Chrome: 'google.com/chrome',
  'Chrome WebView': 'android.com',
  Safari: 'apple.com/safari',
  'Mobile Safari': 'apple.com/safari',
  Firefox: 'firefox.com',
  Edge: 'microsoft.com/edge',
  Opera: 'opera.com',
  'Samsung Internet': 'samsung.com',
  Brave: 'brave.com',
  Arc: 'arc.net',
  Vivaldi: 'vivaldi.com',
  Yandex: 'browser.yandex.com',
  DuckDuckGo: 'duckduckgo.com',
  Instagram: 'instagram.com',
  Facebook: 'facebook.com',
  Twitter: 'x.com',
  LinkedIn: 'linkedin.com',
  Threads: 'threads.net',
  TikTok: 'tiktok.com',
  WebKit: 'webkit.org',
};
const OS_DOMAINS: Record<string, string> = {
  'Mac OS': 'apple.com',
  iOS: 'apple.com',
  iPadOS: 'apple.com',
  Windows: 'microsoft.com',
  Android: 'android.com',
  Linux: 'kernel.org',
  'Chrome OS': 'chromeos.google',
};

const glyphFor = (name: GlyphName, size: number) => <Glyph name={name} size={Math.round(size * 0.85)} />;

export function BrowserIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  return <Favicon domain={name ? BROWSER_DOMAINS[name] : null} size={size} fallback={glyphFor(name === 'App' ? 'phone' : 'globe', size)} />;
}
export function OSIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  // App sessions report "iOS 26.1" or "Android 16".
  const key = name?.startsWith('iOS ') ? 'iOS' : name?.startsWith('Android ') ? 'Android' : name;
  return <Favicon domain={key ? OS_DOMAINS[key] : null} size={size} fallback={glyphFor('laptop', size)} />;
}
export function DeviceIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  return <Favicon size={size} fallback={glyphFor(name === 'Mobile' ? 'phone' : name === 'Tablet' ? 'tablet' : 'desktop', size)} />;
}
/** The platform of a visit: the app (iOS or Android) or the website. */
export function PlatformIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  return <Favicon size={size} fallback={glyphFor(name === 'iOS' || name === 'Android' ? 'phone' : 'desktop', size)} />;
}
/** A country's flag, or the globe glyph when the country is unknown. Flags are the one emoji-font character left: they name data. */
export function Flag({ cc, size = 18 }: { cc: string | null; size?: number }) {
  const f = flag(cc);
  return (
    <span className="inline-flex shrink-0 items-center justify-center text-stone-400" style={{ width: size, height: size, fontSize: size * 0.9 }}>
      {f ?? glyphFor('globe', size)}
    </span>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Background and ink pairs from the stone ramp. Both themes flip the ramp, so each pair keeps its contrast. */
const TONES = [
  { bg: 'rgb(var(--stone-100))', fg: 'rgb(var(--stone-600))' },
  { bg: 'rgb(var(--stone-200))', fg: 'rgb(var(--stone-700))' },
  { bg: 'rgb(var(--stone-300))', fg: 'rgb(var(--stone-800))' },
];

/** "AL" for Ada Lovelace, "A" for ada@example.com, null without a name. */
export function initialsOf(name?: string | null): string | null {
  const words = (name ?? '').replace(/@.*$/, '').split(/[\s._-]+/).filter((w) => /\p{L}|\d/u.test(w));
  if (!words.length) return null;
  const first = (w: string) => [...w.replace(/^[^\p{L}\d]+/u, '')][0]?.toUpperCase() ?? '';
  return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')) || null;
}

/**
 * A visitor's avatar: initials when the site named the person, else a 5 by 5 mirrored pattern from the visitor id,
 * both in a stone tone picked by the id. The same id always looks the same. `cells` lists the filled squares as
 * [column, row].
 */
export function avatarLook(id: string, name?: string | null) {
  const h = hash(id);
  const tone = TONES[h % TONES.length];
  const cells: [number, number][] = [];
  // 15 bits: three columns of five, mirrored onto the other two.
  const bits = hash(`${id}:cells`);
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 5; row++) {
      if (!((bits >> (col * 5 + row)) & 1)) continue;
      cells.push([col, row]);
      if (col < 2) cells.push([4 - col, row]);
    }
  // A pattern needs some ink: an all-empty draw gets the center column.
  if (!cells.length) for (let row = 1; row < 4; row++) cells.push([2, row]);
  return { ...tone, initials: initialsOf(name), cells };
}

/** The avatar drawn inside an SVG chart, centred on (cx, cy) with radius r. */
export function AvatarMark({ id, name, cx, cy, r }: { id: string; name?: string | null; cx: number; cy: number; r: number }) {
  const look = avatarLook(id, name);
  const unit = (r * 1.1) / 5;
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={look.bg} stroke="var(--chart-dot-ring)" strokeWidth={2} />
      {look.initials ? (
        <text x={cx} y={cy} dy="0.36em" textAnchor="middle" fontSize={r * (look.initials.length > 1 ? 0.85 : 1)} fontWeight={600} fill={look.fg}>
          {look.initials}
        </text>
      ) : (
        <g fill={look.fg}>
          {look.cells.map(([c, row]) => (
            <rect key={`${c}-${row}`} x={cx - unit * 2.5 + c * unit} y={cy - unit * 2.5 + row * unit} width={unit} height={unit} />
          ))}
        </g>
      )}
    </>
  );
}

/** A stable avatar per visitor: initials, or a geometric pattern in the stone ramp. */
export function Avatar({ id, name, size = 40, ring = true }: { id: string; name?: string | null; size?: number; ring?: boolean }) {
  const look = avatarLook(id, name);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${ring ? 'ring-2 ring-white' : ''}`}
      style={{ width: size, height: size, background: look.bg, color: look.fg, fontSize: size * (look.initials && look.initials.length > 1 ? 0.38 : 0.44) }}
      aria-hidden="true"
    >
      {look.initials ?? (
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 5 5" fill="currentColor" shapeRendering="crispEdges">
          {look.cells.map(([c, row]) => (
            <rect key={`${c}-${row}`} x={c} y={row} width={1} height={1} />
          ))}
        </svg>
      )}
    </span>
  );
}
