// Page activity is an events row with type 'activity' (migration 0072, docs/API.md "Page activity"). It must change no
// number: every statement that reads `events` filters its type, or is on the list below with the reason it may see
// every type. A new read of events that does neither fails here. Pro's queries are checked too in a Pro checkout.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** Reads that see every type on purpose, by file and a piece of the statement. */
const ALL_TYPES: { file: string; has: string; why: string }[] = [
  { file: 'src/worker/stats.ts', has: 'SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}', why: 'the funnel: every step it builds (conds) is a pageview or a goal' },
  { file: 'src/worker/export.ts', has: 'SELECT e.id, e.ts, e.type, e.name, e.path, e.props, e.session_id, e.visitor_id FROM events e', why: 'the events CSV holds every row, with its type' },
  { file: 'pro/worker/meta-capi.ts', has: 'SELECT COALESCE(MAX(id), 0) AS id FROM events', why: 'a cursor over row ids, not a count' },
  { file: 'pro/worker/meta-api.ts', has: 'SELECT COALESCE(MAX(id), 0) AS id FROM events', why: 'a cursor over row ids, not a count' },
  { file: 'pro/worker/appstats.ts', has: 'WITH cut AS (SELECT ts FROM events WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 ORDER BY ts DESC', why: "Paths' read cap: the time of the newest events, every type, since the paths query reads every event of the visits it reads" },
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

/** Every statement that reads the events table: from the match to the end of its string. */
function reads(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = [];
  for (const abs of [...files(path.join(ROOT, 'src/worker')), ...files(path.join(ROOT, 'pro/worker'))]) {
    const file = path.relative(ROOT, abs);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/\b(FROM|JOIN)\s+events\b/g)) {
      if (/DELETE\s+$/.test(text.slice(Math.max(0, m.index! - 10), m.index!))) continue;
      // The statement runs from the string's start to the call that binds or runs it.
      const start = Math.max(text.lastIndexOf('`', m.index!), text.lastIndexOf("'", m.index!), text.lastIndexOf('prepare(', m.index!));
      const rest = text.slice(m.index!, m.index! + 2000);
      const end = Math.min(...['.bind(', '.first(', '.all(', '.run(', '.raw('].map((q) => rest.indexOf(q)).filter((i) => i >= 0), rest.length);
      out.push({ file, sql: text.slice(start + 1, m.index! + end) });
    }
  }
  return out;
}

describe('reads of the events table', () => {
  let found: ReturnType<typeof reads> = [];
  beforeAll(() => {
    found = reads();
  }, 300_000);

  it('finds the reads it checks', () => {
    expect(found.length).toBeGreaterThan(15);
    expect(found.some((r) => r.file === 'src/worker/stats.ts')).toBe(true);
  });

  it('each one filters the type or is on the list of reads that see every type', () => {
    const bad = found.filter(({ file, sql }) => {
      if (/\btype\s*(=|IN\b)/.test(sql)) return false;
      return !ALL_TYPES.some((a) => a.file === file && sql.replace(/\s+/g, ' ').includes(a.has));
    });
    expect(bad).toEqual([]);
  });
});
