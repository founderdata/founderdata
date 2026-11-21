import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Every tracked page loads public/js/script.js. The build minifies it the way vite.config.ts minifyTracker does; this
// test does the same and gzips at level 9. Round 7's budget (plan section 2, "Cost budget") is 6,700 bytes: 5,554
// before it, then foundation 150, exp 350, survey 200, pages 300, errors 150. A lane that needs more says so in its
// hand-off; the limit here moves only with the plan.
const TRACKER_MAX_GZIP = 6700;

/** The tracker as a visitor gets it: minified, then gzipped at level 9. */
async function trackerBytes(): Promise<{ minified: number; gzip: number }> {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/script.js'), 'utf8');
  const out = await transform(src, { minify: true, target: 'es2017', legalComments: 'inline' });
  return { minified: out.code.length, gzip: gzipSync(out.code, { level: 9 }).length };
}

describe('tracker size', () => {
  it(`stays at or under ${TRACKER_MAX_GZIP.toLocaleString('en-US')} bytes minified and gzipped`, async () => {
    const { minified, gzip } = await trackerBytes();
    console.log(`tracker: ${minified} bytes minified, ${gzip} bytes gzipped (limit ${TRACKER_MAX_GZIP})`);
    expect(gzip).toBeLessThanOrEqual(TRACKER_MAX_GZIP);
  });
});
