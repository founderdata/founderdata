#!/usr/bin/env node
// The two editions from one checkout (docs/PRO.md).
//
//   node scripts/edition.mjs            prints which edition this checkout builds
//   node scripts/edition.mjs check-core [--keep] [--no-test] [--no-build] [vitest args]
//
// check-core copies the tracked files of this checkout without pro/ into a temporary folder, writes the core
// edition files, links node_modules, and runs the typecheck, the tests and the dashboard build there. A Pro checkout
// runs it before every commit, so core keeps working on its own. FOUNDERDATA_CHECK_DIR picks the parent folder of
// the copy (the system temp folder by default); --keep leaves the copy for a look.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const CORE_EDITION = {
  'src/worker/edition.ts': `// Which edition this build is (docs/PRO.md). Core ships \`pro = null\`. FounderData Pro adds the pro/ folder and changes
// this one file to \`export { pro } from '../../pro/worker';\`. No other file in core differs between the editions.
import type { Pro } from './pro-hooks';

export const pro: Pro | null = null;
`,
  'src/dashboard/edition.ts': `// Which edition this build is (docs/PRO.md). Core ships \`proUi = null\`. FounderData Pro adds the pro/ folder and changes
// this one file to \`export { proUi } from '../../pro/dashboard';\`. No other file in core differs between the editions.
import type { ProUi } from './lib/pro';

export const proUi: ProUi | null = null;
`,
};

const edition = () => (existsSync(path.join(ROOT, 'pro/worker/index.ts')) && !/^export const pro\b[^\n]*= null/m.test(readFileSync(path.join(ROOT, 'src/worker/edition.ts'), 'utf8')) ? 'pro' : 'core');

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '1' } });
  return r.status === 0;
}

function checkCore(argv) {
  const keep = argv.includes('--keep');
  const noTest = argv.includes('--no-test');
  const noBuild = argv.includes('--no-build');
  const OWN = new Set(['--keep', '--no-test', '--no-build']);
  const rest = argv.filter((a) => !OWN.has(a));
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('pro/') && existsSync(path.join(ROOT, f)));
  const parent = process.env.FOUNDERDATA_CHECK_DIR || os.tmpdir();
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'founderdata-core-'));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(path.join(ROOT, f), path.join(dir, f));
  }
  // Local, gitignored files the tests read (.dev.vars, .private-words) come along when present.
  for (const f of ['.dev.vars', '.private-words']) if (existsSync(path.join(ROOT, f))) cpSync(path.join(ROOT, f), path.join(dir, f));
  for (const [f, text] of Object.entries(CORE_EDITION)) writeFileSync(path.join(dir, f), text);
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  // git ls-files in the open-source test needs a repository.
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', '-A'], { cwd: dir });
  console.log(`Core edition copy: ${dir} (${files.length} files)`);
  let ok = run('npx', ['tsc', '--noEmit'], dir);
  if (ok && !noBuild) ok = run('npx', ['vite', 'build', '--logLevel', 'warn'], dir);
  if (ok && !noTest) ok = run('npx', ['vitest', 'run', ...rest], dir);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  console.log(ok ? '\nCore edition: OK' : `\nCore edition: FAILED${keep ? ` (copy kept in ${dir})` : ''}`);
  process.exit(ok ? 0 : 1);
}

const [cmd, ...argv] = process.argv.slice(2);
if (cmd === 'check-core') checkCore(argv);
else if (!cmd) console.log(edition());
else {
  console.error('Usage: node scripts/edition.mjs [check-core [--keep] [--no-test] [--no-build] [vitest args]]');
  process.exit(2);
}
