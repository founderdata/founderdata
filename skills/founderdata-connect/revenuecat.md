# RevenueCat

## Unlocks

Every RevenueCat purchase, renewal, refund, trial and cancellation on the dashboard, credited to the app session it
happened in and to that session's source. Steps `payments:<site>`, then `attribution:<site>`. With RevenueCat you skip App
Store Server Notifications (`ios/README.md`, "Using RevenueCat").

## Cost

Free.

## Needs

- A RevenueCat project. The human signs in (STOP).
- The app's bundle id set on the site (`sdk:<site>` needs it too).
- App code: `Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)` after configuring RevenueCat,
  after `logIn`, after `FounderData.reset()` and before each purchase, and purchases through `FounderData.trackPurchase`
  (`skills/founderdata-setup/references/install.md`, section D). The attribute key `founderDataVisitorId` has no `$`.
- Source: `docs/APP-API.md` section 8 and `ios/README.md`.

## Fastest path  [agent, browser, you]

FounderData makes the Authorization secret for you. RevenueCat needs the same string.

1. `npm run connect -- generate revenuecat --site SITE_ID` makes a secret of 16 to 200 characters, stores it as the
   site's `revenuecat_auth`, and shows it **once** on the paste page with a copy button. It is not printed to your stdout.
   **STOP**: the human clicks copy.
2. `agent-browser --headed --session founderdata open https://app.revenuecat.com`. **STOP** for sign-in. Project,
   **Integrations, Webhooks**, add a webhook:
   - URL `ORIGIN/api/webhooks/revenuecat/SITE_ID`
   - Authorization header value: the human pastes the copied string. FounderData accepts it bare or as `Bearer <secret>`.
3. Save. RevenueCat's **Send test event** answers a `TEST` event, which FounderData acknowledges and ignores
   (`{"ok":true,"ignored":"TEST"}`), so a green test proves the secret and the URL, not a purchase.

If the human already has a RevenueCat webhook secret they prefer, `npm run connect -- revenuecat --site SITE_ID` takes it
on the paste page instead.

## Connect command

```bash
npm run connect -- generate revenuecat --site SITE_ID
```

## Verify

`payments:<site>` `waiting` after the webhook is saved, `done` on the first purchase (a sandbox purchase is ignored unless
the site's sandbox setting is on, and never counts as revenue). `attribution:<site>` `done` when a purchase links to an
app session through `founderDataVisitorId`.

## What wrong looks like

- The test event answers 401: the header value differs from the stored secret. Generate again and paste again.
- Answer `400`: no secret is stored for this site yet.
- Purchases arrive with no session: the subscriber attribute is missing or set after the purchase.
