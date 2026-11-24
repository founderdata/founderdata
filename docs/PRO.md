# FounderData Pro

FounderData comes in two editions built from one code base.

**Core** is this repository. It's free and MIT licensed. It tracks your websites, takes in payments from Stripe, Dodo,
Polar, Lemon Squeezy, Paddle, Gumroad, the App Store and RevenueCat, and ties each payment to the visit that brought the
buyer. It also has goals, funnels, page speed, alerts, the weekly report, CSV export, GDPR erasure, share links, the
read API and an MCP server with 9 tools.

**Pro** is core plus a `pro/` folder from a private repository. After launch it costs €99.99 or $99.99
including VAT, paid once, with every update. One license covers all your sites and apps. During launch the price
starts lower and rises in steps ([Price](#price)). Pro adds:

- MRR and its movement, trials, churn, LTV and a retention grid per source, plan and provider, with history imports
  from ChartMogul and RevenueCat
- iOS app analytics (onboarding funnel, paywall, retention), App Store sales, Apple Search Ads, ASO, and the iPhone
  app with widgets and a push for every payment
- Meta ads with the Conversions API, spend from every other channel, MER, CAC and payback
- Search Console, Google rank tracking, the Content view and a page audit
- AI visibility in ChatGPT, Claude, Gemini and Perplexity
- Plan: a growth project your AI agent runs for each site, with your rules for all of them, goals, tasks that say what they should move, session notes, and a measured result for each change against that
- Home across all your sites with the Growth row, next actions, and a verdict on every change you log
- Mail on your own domains through Cloudflare, with an API that answers like Resend's, an inbox and templates ([MAIL.md](MAIL.md))
- People with one story each, from the first visit to the payment, and recordings of their visits in their own
  Recordings section, with what to fix first, off until you turn them on ([GUIDE.md](GUIDE.md#people-and-recordings-pro))
- Web retention and lifecycle for the people your site recognizes ([GUIDE.md](GUIDE.md#retention-and-lifecycle))
- Errors grouped into issues with the paying customers each one hit, and an alert for new ones ([GUIDE.md](GUIDE.md#errors-pro))
- Experiments and feature flags judged on revenue per visitor, with your iOS app's experiments in the same list ([GUIDE.md](GUIDE.md#experiments-pro))
- Click maps and scroll depth on your real pages, and Paths through the site ([GUIDE.md](GUIDE.md#click-maps-heatmaps-and-scroll-depth-pro))
- The survey card for "How did you hear about us?" and "Why are you canceling?", and cancel reasons next to churn ([GUIDE.md](GUIDE.md#surveys))
- All 39 MCP tools, the `query` tool, custom dashboards that agents build, alert rules, the alert inbox, the research log and agent skills
- Teammates with their own login

Both editions run on your own Cloudflare account, and your data stays in your own D1 database.

Core stores everything that arrives from outside in both editions: page views, app events and every payment and
subscription your providers send. When you switch to Pro, the Pro reports cover your history from the first day.

## Price

The launch price rises in steps as licenses sell, up to €99.99. Each step is a capped discount on the one Polar
checkout, and Polar enforces the cap, so the checkout charges the current step's price even when the dashboard is a few
minutes behind. Polar shows the final price before you pay. Prices include VAT.

The dashboard shows one step: its price, the price after launch, the licenses left at that price and the next price.
It reads the numbers from `offer.json` on this repository's `offer` branch
([view it](https://github.com/founderdata/founderdata/blob/offer/offer.json)), in your browser, while a Pro section,
the Pro card in Settings or the support card is on screen. It reads the file again when you come back to the tab and
every 10 minutes. Money is in cents, `regular` is the price after launch, and `sold` counts every license sold at a
launch price:

```json
{
  "regular": 9999,
  "tiers": [{ "price": 499, "seats": 5 }, { "price": 999, "seats": 10 }],
  "sold": 7,
  "checkout": "https://buy.polar.sh/...",
  "updated": "2026-11-19T10:00:00Z"
}
```

The steps follow each other: with the file above, licenses 1 to 5 cost €4.99 and licenses 6 to 15 cost €9.99.
`checkout` is optional and replaces the built-in checkout link; it must be an https link on `buy.polar.sh` or
`polar.sh`. Each step must cost more than the one before. When the file can't be read, or a value is missing or out of
range, the dashboard shows €99.99 and no launch price. `src/shared/offer.ts` checks the file.

## Buy

The **Buy Pro** button on any Pro section of a core dashboard, or in Settings, opens the checkout. Polar handles the payment and the tax.
Your license is read access to the private Pro repository on GitHub, and you claim it in three steps:

1. After you pay, Polar opens your purchase page. Later, open it from the **Access purchase** button in Polar's order
   email, or sign in at [polar.sh/founderdataapp/portal](https://polar.sh/founderdataapp/portal) with the email you
   paid with.
2. Press **Connect GitHub account** and pick the account that git uses on the machine with your FounderData copy.
3. Accept the invitation at
   [github.com/founderdata/founderdata-pro/invitations](https://github.com/founderdata/founderdata-pro/invitations).
   GitHub also emails it to you.

Then install Pro as below.

## License

Core stays MIT. The `pro/` folder and the two Pro edition files come under the license in `pro/LICENSE`. In short, the
license belongs to the one person or company that bought it and can't be transferred or shared. You may run Pro for
your own websites and apps and change it inside your own deployment. You may not share, publish or resell the Pro
code, use it or parts of it in other software, or run it for other people's sites. If your GitHub access ends, you
keep the right to use the copies you already have.

## Install Pro

Pro installs with git, so the changes you made to your own copy stay. In the dashboard, open a Pro section or
Settings, click **Already bought? Install Pro** and paste the prompt into the AI agent that manages your deployment
(Claude Code, Cursor, Codex). The prompt tells it to:

1. Check that git can read the Pro repository, and walk you through the steps under [Buy](#buy) when it can't.
2. Commit your uncommitted changes.
3. Add the Pro repository as the `pro` remote, fetch it and run `git merge pro/main`.
4. Resolve conflicts so your changes and Pro's both survive.
5. Run `npm install`, `npm run typecheck && npm test`, then `npm run setup` to migrate and deploy.
6. Check that Pro is live: `curl -s -o /dev/null -w '%{http_code}' <worker url>/api/apps` prints 401 on Pro and 404
   on core.

By hand:

```bash
git remote add pro https://github.com/founderdata/founderdata-pro.git
git fetch pro
git merge pro/main
npm install && npm run typecheck && npm test
npm run setup
```

Pro differs from core in the `pro/` folder and in two one-line files, `src/worker/edition.ts` and
`src/dashboard/edition.ts`. A merge conflict means you changed a file that the release changed too.

## Updates

Settings has an **Updates** card with the version you run. **Check for updates** reads `release.json` from this
repository's `main` branch in your browser when you click it. If you are behind, it lists every release since your
version with what changed. Core lists its own changes first, then what Pro got. Pro lists both.
[CHANGELOG.md](../CHANGELOG.md) has the same list. The card gives you the prompt for your agent either way. In core, the Pro card under it also reads `offer.json` from GitHub while it is on screen ([Price](#price)).

- Core: `git fetch upstream && git merge upstream/main`, with `upstream` pointing at this repository.
- Pro: `git fetch pro && git merge pro/main`. Every Pro release contains the core release of the same version, so one
  merge brings both.

Then run `npm run setup` as for the first deploy. It applies new migrations and keeps your password and data.

## How the editions fit together

This is for contributors.

- `src/worker/edition.ts` exports `pro`. It's `null` in core. Pro changes the file to export the object from
  `pro/worker/index.ts`. `src/dashboard/edition.ts` does the same for the dashboard (`proUi`).
- `src/worker/pro-hooks.ts` lists every place Pro plugs in: routes, cron jobs, MCP tools, digest sections and more.
  Each hook is optional. Core calls it only when Pro is there and works without it.
- In the dashboard, a Pro section resolves to Pro's component or to the Pro card (`src/dashboard/lib/pages.ts`). Pro
  panels inside core pages render through `ProSlot` by name.
- Scripts for tracked pages: the build bundles each `pro/js/<name>.ts` into `/js/<name>.js`, a static file next to
  `/js/script.js` (`vite.config.ts`, `proScripts`). The recorder `/js/replay.js` comes from `pro/js/replay.ts`. Core has
  no `pro/js`, so its build has no such file.
- Core never imports from `pro/`. `test/edition.test.ts` fails if a core file does.
- `npm run check:core` copies the tree without `pro/`, switches the edition files to core, and runs the typecheck, the
  dashboard build and the tests there. In a Pro checkout, run it before every commit.
- Migrations live in core for both editions, so a database moves between editions without a migration of its own.
