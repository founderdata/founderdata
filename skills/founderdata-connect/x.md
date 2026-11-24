# X posts (Pro)

## Unlocks

Visitors, customers and revenue per post for the X account that posts the site's links, instead of one "X" row. Step id
`x:<site>` (assumed: the real id is in `get_setup`). Needs a `pro/` folder. Optional.

## Cost

X bills reads per post. The Worker reads the account's own timeline: new posts only, up to 100 a call and 3 calls a read, and
the hourly cron reads at most 3 sites a run. The first read goes back 7 days. The human checks their X usage after the
first test, because FounderData has not confirmed that its free test calls cost nothing (`docs/API.md`, "Setup checklist").
**Needs a yes with that cost line.** The viewer login never starts a read, because every read costs money.

## Needs

- An X developer account and an app. The human signs in (STOP). Source: `docs/GUIDE.md`, "Which post paid".
- The handle of the account that posts the links.

## Fastest path  [browser, you]

1. `agent-browser --headed --session founderdata open https://developer.x.com`. **STOP** for sign-in. The console's layout
   changes: snapshot each page.
2. Create an app and generate its **bearer token**. It shows once. **STOP**: the human copies it.
3. `npm run connect -- x` opens the paste page for `X_BEARER_TOKEN`.
4. The human opens the dashboard, the site's Settings, **X posts**, types the handle and presses **Test** (the test calls
   `GET /2/usage/tweets`; a second press within 15 seconds answers 429 and makes no call).

No X API? Settings has "Add a post by hand" (the post's address, its text and the page it links to), which needs no token.

## Connect command

```bash
npm run connect -- x
```

## Verify

The `x` row of `GET /api/setup` goes `ok` after Test. The first read follows within 10 minutes of the owner opening the
dashboard (or at the hourly cron). Posts that link to the site's domain appear with their visitors and revenue.

## What wrong looks like

- Test fails with a plain message: wrong or revoked bearer token, or an app on a plan that cannot read the timeline.
- Posts missing: they do not link to the site's domain, or more than 300 new posts arrived in one read (the older ones are
  skipped and Settings says so).
- Cost surprise: several sites on one handle share one read, and the cost shows on the site that read first.
