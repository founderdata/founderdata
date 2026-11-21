import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, VERSION } from '../src/shared/product';
// @ts-expect-error: a plain .mjs script without types
import { renderChangelog, validate } from '../scripts/release.mjs';

// Core and Pro are one tree (docs/PRO.md): Pro is core plus the pro/ folder and the two edition files. These checks
// keep it that way, so a buyer's merge of Pro only conflicts where they changed a file themselves.
const ROOT = path.resolve(__dirname, '..');
// scripts/edition.mjs holds the core text of the edition files.
const EDITION_FILES = new Set(['src/worker/edition.ts', 'src/dashboard/edition.ts', 'scripts/edition.mjs']);
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !f.startsWith('pro/') && !f.startsWith('test/') && existsSync(path.join(ROOT, f)));

describe('editions', () => {
  it('no core file imports from pro/ but the two edition files', () => {
    const bad = tracked.filter((f) => !EDITION_FILES.has(f) && /from\s+['"][./]*\/?pro\/|import\(\s*['"][./]*\/pro\//.test(readFileSync(path.join(ROOT, f), 'utf8')));
    expect(bad).toEqual([]);
  });

  it('VERSION is the package version', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  });

  it('release.json, CHANGELOG.md and the package version agree (npm run release writes all three)', () => {
    const release = JSON.parse(readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
    expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
    const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(validate(release, { packageVersion: VERSION, changelog })).toEqual([]);
  });

  it('the release check catches a feed out of step', () => {
    const entry = (version: string, core: string[] = ['A fix.'], pro: string[] = []) => ({ version, date: '2026-12-01', core, pro });
    const feed = (releases: ReturnType<typeof entry>[], over: object = {}) => ({ version: releases[0].version, date: '2026-12-01', notes: releases[0].core.join(' '), releases, ...over });
    expect(validate(feed([entry('1.1.0'), entry('1.0.0')]), { packageVersion: '1.1.0' })).toEqual([]);
    expect(validate(feed([entry('1.0.0'), entry('1.1.0')]))[0]).toMatch(/newer than 1.1.0/);
    expect(validate(feed([entry('1.1.0', [], [])]))[0]).toMatch(/at least one change/);
    expect(validate(feed([entry('1.1.0')], { version: '1.2.0' }))[0]).toMatch(/newest release is 1.1.0/);
    expect(validate(feed([entry('1.1.0')]), { packageVersion: '1.0.0' })[0]).toMatch(/package.json says 1.0.0/);
    expect(validate(feed([entry('1.1.0')]), { changelog: '# Changelog\n' })[0]).toMatch(/CHANGELOG.md is out of date/);
    const pro = feed([entry('1.1.0', [], ['Pro only.'])], { notes: 'FounderData Pro: Pro only.' });
    expect(validate(pro)).toEqual([]);
    expect(renderChangelog(pro)).toContain('## 1.1.0 (2026-12-01)\n\nNo changes to core.\n\nFounderData Pro:\n\n- Pro only.\n');
  });

  it('compares versions part by part', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });
});
