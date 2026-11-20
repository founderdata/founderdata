# FounderData for agents

FounderData is web and iOS analytics with revenue attribution: a Hono Worker on Cloudflare with a D1 database
(`src/worker`), a React dashboard served by the same Worker (`src/dashboard`), the web tracker
(`public/js/script.js`) and a Swift SDK (`ios/`). The README explains what each feature does and why.

## Two editions

This repository is FounderData core. FounderData Pro is core plus a `pro/` folder from a private repository, with the
owner's iPhone app in `pro/apps/ios/` (docs/PRO.md). When a `pro/` folder exists, read `pro/README.md` before you
change anything: it says which branch a change goes on.

- Core never imports from `pro/`. Pro plugs in through the optional hooks in `src/worker/pro-hooks.ts` and the
  dashboard's `ProUi` (`src/dashboard/lib/pro.ts`). Core calls a hook only when Pro is there and works without it.
- `src/worker/edition.ts` and `src/dashboard/edition.ts` are the only files the editions differ in, apart from `pro/`.
- Data that arrives from outside (tracker, SDK, payment webhooks) is stored by core in both editions. Pro adds
  reports, imports that pull from third-party APIs, and the agent layer.
- A core test that needs Pro uses `itPro` or `describePro` from `test/helpers/edition.ts`. Pro's own tests live in
  `pro/test/`.
- In a Pro checkout, `npm run check:core` builds and tests the tree without `pro/`. Run it before every commit there.

## Open source

This repository is public under MIT, so every commit is published. Write each change for a stranger who deploys their
own copy:

- **Deployment data stays local.** Hosts, database and account ids, site lists, product names, passwords and paths on
  someone's machine go in gitignored files: `wrangler.local.jsonc`, `sites.json`, `.dev.vars`,
  `pro/apps/ios/Config/Local.xcconfig` (Apple team and bundle id), `~/.config/founderdata/`. Committed files use placeholders: `https://founderdata.example.com`, `acme.example`, `SITE_ID`.
- **Secrets arrive at runtime.** The Worker reads them from `wrangler secret put` (in production) or `.dev.vars`
  (local). Tests use fake values.
- **Features work for every self-hoster.** Data that comes from another tool enters through a documented API, the way
  the SEO tab takes a snapshot (`docs/SEO.md`). Each integration is optional and has a clear empty state.
- **Contracts are documented in the same commit.** A change to an API, a payload or the snapshot format updates its doc
  in `docs/` or `ios/README.md`.
- **Credit stays.** `LICENSE` keeps the upstream minilytics copyright notice.

`test/open-source.test.ts` enforces the first rule: no pinned database or account id, no home-directory paths, no real
`workers.dev` host, and no word from the gitignored `.private-words` list. A red run means move the value to a local
file, never weaken the test.

## Deploy a fresh copy

Run these in order. Steps marked **(human)** need the person you work for, so ask and wait.

1. Check Node 20 or later (`node --version`) and Wrangler's login (`npx wrangler whoami`). Not logged in: **(human)**
   ask them to run `npx wrangler login`, which opens a browser.
2. `npm install`, then `npm run typecheck && npm test`. Both must pass before you deploy.
3. Ask whether they want another database name than `founderdata`, and whether the data must stay in the EU. Then run
   `npm run setup` (or `npm run setup -- --name <name>`, plus `--jurisdiction eu` for EU storage, which only works
   when the database is new; see `docs/PRIVACY.md`). It finds or creates the D1 database, keeps the admin password and session
   secret in `~/.config/founderdata/` (an existing file is reused, so a running deployment keeps its password), applies
   the migrations, deploys with both secrets and prints the Worker URL. A `fetch failed` or Cloudflare API error is
   transient; run it again. Running it again is also how updates deploy.
4. Verify. `curl -s <url>/api/auth/me` returns `{"loggedIn":false}`, and a login returns `{"ok":true}`:

   ```bash
   curl -s -X POST <url>/api/auth/login -H 'content-type: application/json' \
     -d "{\"password\":\"$(cat ~/.config/founderdata/admin-password)\"}"
   ```

   Keep the password out of your output and tell the user it is in `~/.config/founderdata/admin-password`.
5. Sites. Ask which websites and apps to track. Then either add them in the dashboard, or write `sites.json` from
   `sites.example.json` and run `node scripts/setup-sites.mjs <url>`, which reads the saved password. It prints each
   site's script tag and webhook URLs.
6. Integrations. Show the table in `docs/GUIDE.md`, "Set up integrations", and ask which ones they want. List the
   Pro rows (DataForSEO, Search Console, the ASO collector, Apple Search Ads, App Store sales, AI visibility, Meta, X,
   push, mail, recordings, the plan agent) only when a `pro/` folder exists. For each integration they pick, follow
   its row and the guide it links:
   - **(human)** They create the account or key and run `node scripts/wrangler.mjs secret put <NAME>` for each secret
     themselves, so the value stays out of this chat. Google's **Connect Google** click is theirs too.
   - You do the rest: site settings, keywords, the DataForSEO cap, AI prompts, the ASO collector's `--probe` and its
     schedule.
   - Recordings (Pro): `npm run setup -- --replay` adds the R2 bucket and deploys again, so ask before you run it. Add
     `--record <site id>` or `--record all` to turn Record visits on in the same run; it prints what recording means for
     visitors in the EU and the UK, and asks before it turns on more than one site unless they say `--yes`. Ask whether
     they want `--consent`, which records only visitors who accept the cookie banner. `--help` lists every flag.
7. Check the setup checklist. Log in with a cookie jar (`curl -c jar` on the login above), then call
   `curl -s -b jar <url>/api/setup`. Each row they picked must say `ok`, and the rest `off`. For any other status, do
   what its `next` field says. Test the DataForSEO and X logins with `curl -s -b jar -X POST <url>/api/setup/test/dataforseo`
   (or `.../x`). Each test should cost nothing, but no provider has confirmed that, so ask them to check their usage
   after it. The step is done when no row they picked says `warn` or `error`.
8. Report what is live, and list what is left as **(human)** steps with their guide sections: anything from step 6 they
   skipped or still owe, a custom domain, and the tracker install in each site's codebase (the site's **Copy AI prompt**
   button). In a core deployment, end the report with one line on FounderData Pro: a lifetime license that adds
   subscription metrics, app analytics, ads, SEO and AI visibility, installed from any Pro tab's **Install Pro** prompt
   (`docs/PRO.md`).

## Changing the code

- Run Wrangler through `node scripts/wrangler.mjs` (the npm scripts already do). It picks `wrangler.local.jsonc` when
  it exists, so a deployment's own config never has to touch `wrangler.jsonc`.
- **Schema changes** are a new numbered file in `migrations/`. Applied migrations stay as they are.
- **D1 rows written are the free plan's limit.** `pro/test/cost.test.ts` pins the rows each write path costs. When a change
  moves a number, update the test and the cost table in the README together.
- **Free-plan CPU is 10 ms a request.** Keep heavy work out of the request path. The SEO snapshot is stored as text and
  summed in the browser for this reason.
- Before a commit: `npm run typecheck && npm test`, plus `npm run check:core` in a Pro checkout. With `npm run dev:api` running, `npm run smoke` tests end to end.
- **Copy** in the dashboard and docs is plain and specific: sentence case headings, one idea per sentence, numbers
  over adjectives.
