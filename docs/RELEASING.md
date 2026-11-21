# Releasing

FounderData has one version number for the server, the dashboard, the Swift package and FounderData Pro. This page is
for maintainers. A self-hoster updates through Settings > Updates ([PRO.md](PRO.md#updates)).

## Versions

Versions are plain semver with no `v`: `1.5.0`.

- **Major** when a deployment or an app has to change something: a breaking API change, a removed route, a Swift API
  change (ios/README.md, "Versions").
- **Minor** for new features.
- **Patch** when a release only fixes bugs.

Core and Pro release together under the same number. A Pro release always contains the core release of its version.

## Where a version lives

| File | Holds | Written by |
|---|---|---|
| `release.json` | every release, newest first, with what changed in `core` and in `pro` | you, then `npm run release` |
| `CHANGELOG.md` | the same list as Markdown, for GitHub | `npm run release` |
| `package.json`, `package-lock.json` | the version this build reports (`VERSION` in `src/shared/product.ts`) | `npm run release` |
| `ios/CHANGELOG.md` | changes to the Swift package | you, when `ios/Sources` or `Package.swift` changed |
| git tag `1.5.0` on core | the release commit; Swift Package Manager resolves versions from it | `npm run release` |
| git tag `pro-1.5.0` on Pro | the Pro merge of that release | `npm run release -- pro` |

Every dashboard reads `release.json` from the public `main` branch when its owner clicks **Check for updates**. It lists
each release between the deployed version and the latest one. Core shows its own changes first and Pro's under
"In FounderData Pro". Pro shows both. Dashboards older than 1.5.0 read only the top-level `notes`, which the script writes
from the newest entry.

`test/edition.test.ts` fails when `release.json`, `CHANGELOG.md` and `package.json` disagree.

## Write the changes

Each change is one sentence a deployment owner understands without the code: what they can now do or what stopped
going wrong. Leave out refactors, tests and docs-only commits. A change that only Pro buyers see goes under `pro`, even
when it needed a core hook.

## Release

In the maintainer checkout (pro/README.md, "Repositories and branches"):

1. On `core`, with a clean working tree, run `npm run release -- 1.5.0`. The first run adds an empty `1.5.0` entry to
   the top of `release.json` and stops.
2. Fill in its `core` and `pro` lists and run `npm run release -- 1.5.0` again. It checks the version is newer than
   `package.json`, asks for an `ios/CHANGELOG.md` entry if the Swift package changed since the last tag, writes the
   version and the changelog, runs `npm run typecheck` and `npm test`, commits `Release 1.5.0` and tags `1.5.0`.
3. Publish core. The script prints the commands:

   ```bash
   git push core core:main 1.5.0
   gh release create 1.5.0 --repo founderdata/founderdata --title 1.5.0 --notes "$(npm run -s release -- notes 1.5.0)"
   ```

4. Release Pro straight away. A Pro buyer who updates between the two pushes gets the previous Pro release.

   ```bash
   git switch main && git merge core
   npm run release -- pro 1.5.0   # typecheck, tests, check:core, tag pro-1.5.0
   git push origin main pro-1.5.0
   ```

`npm run release -- check` validates the files without changing anything. `--date YYYY-MM-DD` sets another release
day, and `--no-test` skips the checks when you ran them a minute ago.

The script never pushes. If a check fails, nothing is committed: fix it and run the same command again.
