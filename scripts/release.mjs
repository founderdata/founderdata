#!/usr/bin/env node
// Releases (docs/RELEASING.md). release.json is the source: every release, newest first, with what changed in core and
// in Pro. This script keeps package.json, package-lock.json and CHANGELOG.md in step with it, runs the checks, then
// commits and tags. It never pushes; it prints the push commands.
//
//   npm run release -- check                validate release.json, CHANGELOG.md and the package version
//   npm run release -- notes <version>      print one release as Markdown (for a GitHub release)
//   npm run release -- <version> [--date YYYY-MM-DD] [--no-test]
//                                           core: bump, write the changelog, check, commit, tag <version>
//   npm run release -- pro <version> [--no-test]
//                                           Pro, after merging the core release: check (with check:core), tag pro-<version>
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function compareVersions(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The one-paragraph notes that dashboards before 1.5.0 show: core changes, then Pro's. */
export function notesParagraph(entry) {
  const parts = [];
  if (entry.core.length) parts.push(entry.core.join(' '));
  if (entry.pro.length) parts.push(`FounderData Pro: ${entry.pro.join(' ')}`);
  return parts.join(' ');
}

/** One release as Markdown, without its heading. */
export function releaseBody(entry) {
  const list = (items) => items.map((x) => `- ${x}`).join('\n');
  const out = [entry.core.length ? list(entry.core) : 'No changes to core.'];
  if (entry.pro.length) out.push(`FounderData Pro:\n\n${list(entry.pro)}`);
  return out.join('\n\n');
}

export function renderChangelog(feed) {
  const head = `# Changelog

Every release of FounderData, newest first. Core and FounderData Pro share version numbers, and each Pro release
contains the core release of the same version. The Swift package lists its own changes in
[ios/CHANGELOG.md](ios/CHANGELOG.md).

This file is made from \`release.json\` by \`npm run release\` (docs/RELEASING.md). Edit \`release.json\`, not this file.
`;
  return [head, ...feed.releases.map((e) => `## ${e.version} (${e.date})\n\n${releaseBody(e)}\n`)].join('\n');
}

/** Every problem with release.json, CHANGELOG.md and the package version, as sentences. Empty means all is in step. */
export function validate(feed, { packageVersion, changelog } = {}) {
  const errors = [];
  if (!feed || !Array.isArray(feed.releases) || !feed.releases.length) return ['release.json has no releases list.'];
  feed.releases.forEach((e, i) => {
    const name = e?.version ?? `entry ${i + 1}`;
    if (typeof e?.version !== 'string' || !SEMVER.test(e.version)) errors.push(`${name}: the version is not x.y.z.`);
    if (typeof e?.date !== 'string' || !DAY.test(e.date)) errors.push(`${name}: the date is not YYYY-MM-DD.`);
    for (const k of ['core', 'pro']) {
      if (!Array.isArray(e?.[k]) || e[k].some((x) => typeof x !== 'string' || !x.trim())) errors.push(`${name}: ${k} must be a list of sentences.`);
    }
    if (Array.isArray(e?.core) && Array.isArray(e?.pro) && !e.core.length && !e.pro.length) errors.push(`${name}: list at least one change.`);
    const next = feed.releases[i + 1];
    if (next && typeof e?.version === 'string' && typeof next.version === 'string' && compareVersions(e.version, next.version) <= 0) {
      errors.push(`${name} must be newer than ${next.version}, the release after it in the list.`);
    }
  });
  if (errors.length) return errors;
  const latest = feed.releases[0];
  if (feed.version !== latest.version) errors.push(`version is ${feed.version}, but the newest release is ${latest.version}.`);
  if (feed.date !== latest.date) errors.push(`date is ${feed.date}, but the newest release is from ${latest.date}.`);
  if (feed.notes !== notesParagraph(latest)) errors.push('notes do not match the newest release. Run npm run release to write them.');
  if (packageVersion !== undefined && packageVersion !== feed.version) errors.push(`package.json says ${packageVersion}, release.json ${feed.version}.`);
  if (changelog !== undefined && changelog !== renderChangelog(feed)) errors.push('CHANGELOG.md is out of date. Run npm run release to write it.');
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------- CLI

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));
const writeJson = (f, data) => writeFileSync(path.join(ROOT, f), `${JSON.stringify(data, null, 2)}\n`);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const edition = () => (existsSync(path.join(ROOT, 'pro/worker/index.ts')) && !read('src/worker/edition.ts').includes('= null') ? 'pro' : 'core');

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  if (spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status !== 0) fail(`${cmd} ${args.join(' ')} failed. Nothing was committed.`);
}

function dirtyFiles() {
  // Not git(): its trim() would eat the status column of the first line.
  return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function check() {
  const errors = validate(readJson('release.json'), { packageVersion: readJson('package.json').version, changelog: existsSync(path.join(ROOT, 'CHANGELOG.md')) ? read('CHANGELOG.md') : '' });
  if (errors.length) fail(`\n- ${errors.join('\n- ')}`);
  console.log('release.json, CHANGELOG.md and package.json agree.');
}

function notes(version) {
  const entry = readJson('release.json').releases?.find((e) => e.version === version);
  if (!entry) fail(`release.json has no release ${version}.`);
  console.log(releaseBody(entry));
}

/** Tags must not exist yet, locally or on the remote that publishes them. */
function assertNewTag(tag) {
  if (git('tag', '--list', tag)) fail(`the tag ${tag} exists already.`);
}

function releaseCore(version, argv) {
  if (edition() !== 'core') fail('a release starts on the core branch (pro/README.md, "Release"). Switch to core, or run `release pro` here after merging it.');
  if (!SEMVER.test(version)) fail(`${version} is not a version like 1.5.0.`);
  const pkg = readJson('package.json');
  if (compareVersions(version, pkg.version) <= 0) fail(`${version} is not newer than ${pkg.version}.`);
  assertNewTag(version);
  const others = dirtyFiles().filter((f) => !['release.json', 'ios/CHANGELOG.md'].includes(f));
  if (others.length) fail(`commit or stash these first, so the release commit holds only the release:\n  ${others.join('\n  ')}`);

  const feed = readJson('release.json');
  const dateArg = argv.indexOf('--date');
  const date = dateArg >= 0 ? argv[dateArg + 1] : today();
  if (!DAY.test(date ?? '')) fail('--date takes YYYY-MM-DD.');
  if (feed.releases?.[0]?.version !== version) {
    feed.releases = [{ version, date, core: [], pro: [] }, ...(feed.releases ?? [])];
    writeJson('release.json', feed);
    fail(`added ${version} to the top of release.json. List its changes under core and pro, one plain sentence each, then run this again.`);
  }
  const entry = feed.releases[0];
  if (!entry.core.length && !entry.pro.length) fail(`${version} in release.json lists no changes. Add them under core and pro, then run this again.`);

  // An SDK change since the last release needs its own entry in ios/CHANGELOG.md (ios/README.md, "Versions").
  const previous = pkg.version;
  if (git('tag', '--list', previous)) {
    const sdk = git('diff', '--name-only', previous, 'HEAD', '--', 'ios/Sources', 'Package.swift');
    if (sdk && !read('ios/CHANGELOG.md').includes(`## ${version} `)) fail(`the Swift package changed since ${previous}:\n  ${sdk.split('\n').join('\n  ')}\nAdd "## ${version} (${date})" to ios/CHANGELOG.md, then run this again.`);
  }

  entry.date = date;
  feed.version = version;
  feed.date = date;
  feed.notes = notesParagraph(entry);
  const ordered = { version: feed.version, date: feed.date, notes: feed.notes, releases: feed.releases };
  const errors = validate(ordered);
  if (errors.length) fail(`release.json:\n- ${errors.join('\n- ')}`);
  writeJson('release.json', ordered);
  pkg.version = version;
  writeJson('package.json', pkg);
  const lock = readJson('package-lock.json');
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeJson('package-lock.json', lock);
  writeFileSync(path.join(ROOT, 'CHANGELOG.md'), renderChangelog(ordered));

  if (!argv.includes('--no-test')) {
    run('npm', ['run', 'typecheck']);
    run('npm', ['test']);
  }
  git('add', 'release.json', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'ios/CHANGELOG.md');
  git('commit', '-m', `Release ${version}`, '-m', releaseBody(entry));
  git('tag', '-a', version, '-m', `FounderData ${version}`);
  console.log(`
Committed and tagged ${version}. Publish it:

  git push core core:main ${version}     # every dashboard sees the update, Swift packages see the tag
  gh release create ${version} --repo founderdata/founderdata --title ${version} --notes "$(npm run -s release -- notes ${version})"

Then release Pro right away (a Pro buyer who updates in between gets the previous Pro release):

  git switch main && git merge core
  npm run release -- pro ${version}`);
}

function releasePro(version, argv) {
  if (edition() !== 'pro') fail('`release pro` runs in the Pro checkout, on main, after merging the core release.');
  const pkg = readJson('package.json');
  if (pkg.version !== version) fail(`package.json says ${pkg.version}. Merge the core release ${version} first: git merge core.`);
  if (dirtyFiles().length) fail('the working tree has changes. Commit or stash them first.');
  const tag = `pro-${version}`;
  assertNewTag(tag);
  check();
  if (!argv.includes('--no-test')) {
    run('npm', ['run', 'typecheck']);
    run('npm', ['test']);
    run('npm', ['run', 'check:core']);
  }
  git('tag', '-a', tag, '-m', `FounderData Pro ${version}`);
  console.log(`
Tagged ${tag}. Publish it to buyers:

  git push origin main ${tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'check') check();
  else if (cmd === 'notes' && rest[0]) notes(rest[0]);
  else if (cmd === 'pro' && rest[0]) releasePro(rest[0], rest.slice(1));
  else if (cmd && SEMVER.test(cmd)) releaseCore(cmd, rest);
  else fail('usage: npm run release -- check | notes <version> | <version> [--date YYYY-MM-DD] [--no-test] | pro <version> [--no-test]');
}
