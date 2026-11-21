import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_LABELS, type View } from '../src/dashboard/lib/sections';

// The section switch in src/dashboard/pages/Dashboard.tsx: every section the routes open renders its own view. A view
// missing from the switch falls through to Drop-off, which is how /site/:id/errors and /errors/<issue> showed Drop-off
// in round 7 (lane errors review).
describe('dashboard view switch', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/dashboard/pages/Dashboard.tsx'), 'utf8');

  it('renders each section with its own view, and only Drop-off as the fallback', () => {
    for (const v of Object.keys(SECTION_LABELS) as View[]) {
      if (v === 'overview' || v === 'dropoff') continue;
      expect(src, v).toMatch(new RegExp(`view === '${v}' \\? \\(\\s*<Views\\.${v}\\b`));
    }
    expect(src).toMatch(/:\s*\(\s*<Views\.dropoff appOnly=\{appOnly\} \/>\s*\)\}/);
  });

  it('renders Errors and Experiments, the round 7 sections', () => {
    expect(src).toMatch(/view === 'errors' \? \(\s*<Views\.errors \/>/);
    expect(src).toMatch(/view === 'experiments' \? \(\s*<Views\.experiments \/>/);
  });
});
