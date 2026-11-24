# Install tracking and revenue attribution in a codebase

For `[agent]` step 4 of `founderdata-setup`. Run it once per product, inside that product's repository. It is the same task
list as the **Copy AI prompt** button on a site in the dashboard (`src/dashboard/lib/aiPrompt.ts` builds that prompt, and
wins if the two differ).

Fill these from step 3 and use them unchanged:

- `ORIGIN`: the Worker URL, for example `https://founderdata.example.com`
- `SITE_ID`, `DOMAIN`, `CURRENCY`: from `setup-sites.mjs`
- Script tag: `<script defer data-website-id="SITE_ID" src="ORIGIN/js/script.js"></script>`

Ask the human only what the code cannot tell you, all at once, before you edit. No secret is needed here.

## A. Website: load the script on every page

1. Find where the project renders `<head>`: Next.js `app/layout.tsx` or `pages/_document.tsx`, a Vite or CRA `index.html`,
   the root layout of Astro, Nuxt, SvelteKit or Remix, plain HTML, WordPress `header.php`. Add the tag so it loads on every
   page, including the logged-in app and any subdomain in this repo.
2. Next.js: `<Script defer data-website-id="SITE_ID" src="ORIGIN/js/script.js" strategy="afterInteractive" />` from
   `next/script`.
3. Keep the attributes exactly and load it once. It follows single-page navigation itself, so add no pageview calls.
4. A Content-Security-Policy needs `ORIGIN` in `script-src` and `connect-src`.
5. `data-fd-mask` on elements whose text must never appear in a recording, `data-fd-block` on parts that must not be
   recorded at all.
6. The script ignores localhost. To test locally add `data-allow-localhost`, and remove it before you commit.

## B. Revenue attribution (the part that matters)

`window.founderdata?.attribution?.() ?? {}` returns `{ rt_visitor_id, rt_session_id, rt_site_id }` (empty for a fraction of
a second after load). Every checkout must carry these ids so a payment finds its visit. The browser code that starts a
checkout reads them and sends them to the server in the request body. The server merges them into the existing metadata and
keeps every key already there.

Find the providers: search for `stripe`, `checkout.sessions.create`, `paymentIntents.create`, `buy.stripe.com`,
`dodopayments`, `RevenueCat`, `Purchases.configure`, `StoreKit`, `paddle`, `lemonsqueezy`, `polar`, `gumroad`. Do the rows
for the providers you find.

| Provider | Change |
| --- | --- |
| Stripe Checkout | `metadata: { ...existing, ...rt }`. Subscriptions also `subscription_data: { metadata: { ...existing, ...rt } }`, so renewals carry the ids |
| Stripe PaymentIntent | `metadata: { ...existing, ...rt }` on the PaymentIntent |
| Stripe Payment Links | none: the script adds `client_reference_id=rtv_<visitor id>`. A link opened from JavaScript needs `?client_reference_id=rtv_<rt_visitor_id>` appended, unless it has its own |
| Dodo | `metadata: { ...existing, rt_visitor_id: rt.rt_visitor_id ?? '', rt_session_id: rt.rt_session_id ?? '' }`. Give every checkout a return URL on this site (a page that loads the script): Dodo adds `?payment_id=` and FounderData links on it when metadata is lost |
| Lemon Squeezy | links need none. API checkouts: `checkout_data: { custom: { ...existing, rt_visitor_id, rt_session_id, rt_site_id: 'SITE_ID' } }` |
| Polar | `buy.polar.sh` links need none. API checkouts: `metadata: { ...existing, rt_visitor_id, rt_session_id }` |
| Paddle Billing | `Paddle.Checkout.open({ ..., customData: { ...existing, ...(window.founderdata?.attribution?.() ?? {}) } })`, and the same keys in `custom_data` for server-made transactions |
| Gumroad | `gumroad.com/l/...` links need none. A link opened from JavaScript needs `?rt_visitor_id=<id>&rt_session_id=<id>` |
| Any other | pass the ids through the provider's custom data, then in the server code that handles its "payment succeeded" webhook call `POST ORIGIN/api/v1/payments` with `Authorization: Bearer $FOUNDERDATA_API_KEY` and `{ transaction_id, amount, currency, visitor_id, session_id, email }` (a refund sends the same `transaction_id` with `"refunded": true`). The `rt_...` key is in the site's Settings, Payments. Tell the human to set it as an environment variable. Never hardcode it, and never let this call fail the provider's webhook |

Do not write webhook receiver code for FounderData: the webhooks go to FounderData itself, and
`founderdata-connect` creates them.

## C. Identify users and track goals

- After login or signup, and on app load with a session: `window.founderdata?.('identify', { user_id, email, name })`. This
  links earlier anonymous visits and lets a payment without ids find its person by email.
- Main buttons: `data-rt-goal="signup_click"`, `start_trial`, `pricing_cta`, `checkout_click`, plus
  `window.founderdata?.('goal', 'signup_completed')` after a successful signup. Extra properties go in
  `data-rt-goal-plan="pro"`.
- Always call with optional chaining so a blocked script never breaks a page. TypeScript needs
  `declare global { interface Window { founderdata?: ((cmd: 'goal' | 'identify' | 'pageview' | 'consent', a?: any, b?: any) => void) & { attribution?: () => { rt_visitor_id?: string; rt_session_id?: string; rt_site_id?: string } } } }`.

## D. iOS app

Needs the site's bundle id set first (step 3). The full guide is `ios/README.md`.

1. Add the package `https://github.com/founderdata/founderdata`, product `FounderDataKit`, Up to Next Major Version from
   1.0.0, linked to the app target. In an Xcode project that is `skills/founderdata-connect/app-store.md`. In a
   `Package.swift`: `.package(url: "https://github.com/founderdata/founderdata", from: "1.0.0")`.
2. In `App.init()`: `FounderData.configure(siteId: "SITE_ID", host: "ORIGIN")`, then `FounderData.observeTransactions()`.
   Root view: `.onOpenURL { FounderData.handle(url: $0) }`. Each screen: `.founderDataScreen("Settings")`. Sign-out:
   `FounderData.reset()`.
3. StoreKit purchases: `try await FounderData.purchase(product, source: .onboarding)` (or `.settings`, `.featureGate`).
   Code that calls `product.purchase` itself adds `.appAccountToken(FounderData.appAccountToken)` and passes the verified
   result to `FounderData.track(purchase:)`.
4. RevenueCat instead: `Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)` after configuring
   RevenueCat, after `logIn`, after `FounderData.reset()` and before each purchase. Buy through
   `FounderData.trackPurchase(product:source:)`. Skip App Store Server Notifications.
5. Onboarding: `FounderData.onboardingStep(1, "welcome")` and so on, then `FounderData.onboardingComplete()`. Paywall:
   `FounderData.paywallViewed(source:)`.

## E. Finish

Keep changes small and in the repo's style. Run its typecheck and tests. Then tell the human, in this order: files changed
and why, which providers you found and which checkout paths now send the ids (and any you could not find), what they still
set up themselves (webhooks and secrets: `founderdata-connect`), the goals you added, and how to check: open the site, and
in DevTools Network a `POST ORIGIN/api/event` answers 202.
