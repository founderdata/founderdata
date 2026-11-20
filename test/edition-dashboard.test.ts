import { describe, expect, it } from 'vitest';
import { newerRelease, parseRelease, releaseOf, releasesSince } from '../src/dashboard/lib/updates';

describe('update check', () => {
  it('parses a release file', () => {
    expect(parseRelease('{"version":"1.2.0","date":"2026-12-01","notes":"Faster."}')).toEqual({ version: '1.2.0', date: '2026-12-01', notes: 'Faster.' });
    expect(parseRelease('{"version":"1.2.0"}')).toEqual({ version: '1.2.0', date: '', notes: undefined });
  });

  it('rejects an answer that is not a release', () => {
    expect(parseRelease('<html>404: Not Found</html>')).toBeNull();
    expect(parseRelease('null')).toBeNull();
    expect(parseRelease('{"date":"2026-12-01"}')).toBeNull();
    expect(parseRelease('{"version":"latest"}')).toBeNull();
    expect(parseRelease('{"version":2}')).toBeNull();
  });

  it('offers only a newer version', () => {
    const r = (version: string) => ({ version, date: '' });
    expect(newerRelease('1.0.0', r('1.0.1'))?.version).toBe('1.0.1');
    expect(newerRelease('1.9.0', r('1.10.0'))?.version).toBe('1.10.0');
    expect(newerRelease('1.0.0', r('1.0.0'))).toBeNull();
    expect(newerRelease('2.0.0', r('1.9.9'))).toBeNull();
  });

  it('lists every release since this build, newest first', () => {
    const feed = parseRelease(
      JSON.stringify({
        version: '1.6.0',
        date: '2026-12-03',
        notes: 'All of it.',
        releases: [
          { version: '1.5.0', date: '2026-12-02', core: ['B.'], pro: [] },
          { version: '1.6.0', date: '2026-12-03', core: [], pro: ['C.'] },
          { version: 'next', core: ['skipped'] },
          { version: '1.4.0', date: '2026-12-01', core: ['A.', 3], pro: 'no list' },
        ],
      }),
    )!;
    expect(feed.releases?.map((e) => e.version)).toEqual(['1.6.0', '1.5.0', '1.4.0']);
    expect(feed.releases?.[2]).toEqual({ version: '1.4.0', date: '2026-12-01', core: ['A.'], pro: [] });
    expect(releasesSince('1.4.0', feed).map((e) => e.version)).toEqual(['1.6.0', '1.5.0']);
    expect(releasesSince('1.6.0', feed)).toEqual([]);
    expect(releaseOf('1.5.0', feed)?.core).toEqual(['B.']);
    expect(releaseOf('1.3.0', feed)).toBeNull();
  });

  it('falls back to the notes of a feed without a release list', () => {
    const feed = parseRelease('{"version":"1.2.0","date":"2026-12-01","notes":"Faster."}')!;
    expect(releasesSince('1.0.0', feed)).toEqual([{ version: '1.2.0', date: '2026-12-01', core: ['Faster.'], pro: [] }]);
    expect(releaseOf('1.2.0', feed)).toBeNull();
  });
});
