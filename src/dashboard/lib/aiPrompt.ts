import type { Site } from './api';
import { isAppOnly } from './siteKind';

/**
 * A copy-paste prompt for the site owner's coding AI (Claude Code, Cursor, Copilot),
 * filled with this site's real values so the AI can install tracking and revenue attribution itself.
 * The API key and webhook secrets are deliberately left out: only the generic payments API needs the key, and the
 * prompt tells the AI to read it from an environment variable.
 */
export function buildAiPrompt(site: Site, origin: string): string {
  if (isAppOnly(site)) return buildAppPrompt(site, origin);
  const script = `<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`;
  return `Set up FounderData analytics and revenue attribution in this codebase. FounderData is my own analytics service, similar to DataFast or Plausible. Make the changes directly in the code. Ask me only what you cannot find out by reading the codebase, and ask all of it at once before you change anything.

## My FounderData values (correct as written, use them unchanged)
- Dashboard and API host: ${origin}
- Website ID: ${site.id}
- Tracked domain: ${site.domain} (subdomains such as app.${site.domain} count as the same site)
- Revenue currency: ${site.currency}
- Script tag:
  ${script}

## Task 1: load the tracking script on every page
- Find where this project renders the HTML <head> (Next.js app/layout.tsx or pages/_document.tsx, a Vite or CRA index.html, the Astro, Nuxt, SvelteKit or Remix root layout, plain HTML files, WordPress header.php) and add the script tag so it loads on every page, including the logged-in app and any subdomain that lives in this repo.
- Next.js: use next/script: <Script defer data-website-id="${site.id}" src="${origin}/js/script.js" strategy="afterInteractive" />
- Keep the attributes exactly as given and load the script once. The script tracks single-page-app navigation itself, so add no manual pageview calls.
- If the project sends a Content-Security-Policy, allow ${origin} in script-src and connect-src.
- Put data-fd-mask on elements whose text must never show in a visit recording (a customer's name, an account balance), and data-fd-block on whole parts of a page that must not be recorded at all.

## Task 2: revenue attribution (the most important task)
The script sets no cookies by default. In the browser, window.founderdata.attribution() returns { rt_visitor_id, rt_session_id, rt_site_id }. For a fraction of a second after page load, until the first tracking request returns, it returns an empty object. Every payment must carry these ids, so FounderData can tell which visitor, and so which tweet, article or Google result, made the money.

First find out which payment providers this codebase uses. Search for: "stripe", "checkout.sessions.create", "paymentIntents.create", "buy.stripe.com", "dodopayments", "checkout.dodopayments.com", "RevenueCat", "Purchases.configure", "StoreKit", "product.purchase", "paddle", "lemonsqueezy", "polar", "gumroad". Then do the steps for each provider you find, and skip the others. In every case, the browser code that starts a checkout reads window.founderdata?.attribution?.() ?? {} and sends it to the server in the request body, and the server merges it into the existing metadata, keeping every existing key. Only when the script tag has data-cookies="on" can the server read the first-party cookies rt_vid and rt_sid from the request instead.

### Stripe
- Checkout Sessions: metadata: { ...existingMetadata, ...rt }. For subscriptions also set subscription_data: { metadata: { ...existing, ...rt } }, so renewals carry the ids.
- PaymentIntents created directly: metadata: { ...existingMetadata, ...rt } on the PaymentIntent.
- Keep rt_site_id in the metadata. It tells FounderData which site a payment belongs to when several sites share one Stripe account.
- Static Payment Links (<a href="https://buy.stripe.com/...">) need no change, because the script adds client_reference_id=rtv_<visitor id> to them. If code sends the browser to a Payment Link with JavaScript, append ?client_reference_id=rtv_<rt_visitor_id> yourself, unless the link already sets client_reference_id.
- Do not add Stripe webhook code for FounderData. I add the endpoint ${origin}/api/webhooks/stripe/${site.id} in the Stripe dashboard myself.

### Dodo Payments
- Checkout sessions, payments and subscriptions: metadata: { ...existingMetadata, rt_visitor_id: rt.rt_visitor_id ?? '', rt_session_id: rt.rt_session_id ?? '' }
- Static payment links (<a href="https://checkout.dodopayments.com/buy/...">) need no change, because the script adds the metadata to them. If code sends the browser to a payment link with JavaScript, append ?metadata_rt_visitor_id=<id>&metadata_rt_session_id=<id> yourself.
- Give every checkout a return URL on this site (return_url: 'https://${site.domain}/thanks' for checkout sessions, ?redirect_url=... on payment links), and make sure that page loads the FounderData script. Dodo appends ?payment_id=... to it, and FounderData uses that to link the payment when the metadata is lost.
- Do not add Dodo webhook code. I add ${origin}/api/webhooks/dodo/${site.id} in the Dodo dashboard myself.

### iOS app with StoreKit (App Store purchases)
- Add the FounderDataKit Swift package (https://github.com/founderdata/founderdata, product FounderDataKit) to the app target.
- In the App init: FounderData.configure(siteId: "${site.id}", host: "${origin}"), then FounderData.observeTransactions(). On the root view: .onOpenURL { FounderData.handle(url: $0) }.
- Buy with try await FounderData.purchase(product, source: .onboarding) (or .settings, .featureGate: where the paywall opened). It adds the app account token, sends the purchase goals and records the verified purchase. Code that calls product.purchase itself adds .appAccountToken(FounderData.appAccountToken) to the options and passes a verified result to FounderData.track(purchase:).
- The site's bundle id in FounderData must match the app's${site.app_bundle_id ? ` (currently ${site.app_bundle_id})` : ' (not set yet; tell me to set it in the site settings)'}. I point App Store Server Notifications at ${origin}/api/webhooks/apple/${site.id} myself.

### RevenueCat
- In the app, before a purchase, set the subscriber attribute founderDataVisitorId to FounderData.appAccountToken.uuidString.lowercased() (Purchases.shared.attribution.setAttributes(["founderDataVisitorId": ...])). Attribute keys must not start with $.
- I add the webhook ${origin}/api/webhooks/revenuecat/${site.id} in RevenueCat myself.

### Lemon Squeezy
- Checkout links on the page (<a href="https://STORE.lemonsqueezy.com/checkout/...">) need no change, because the script adds checkout[custom][rt_visitor_id], rt_session_id and rt_site_id to them.
- Checkouts created with the API: checkout_data: { custom: { ...existingCustom, rt_visitor_id: rt.rt_visitor_id ?? '', rt_session_id: rt.rt_session_id ?? '', rt_site_id: '${site.id}' } }.
- Do not add webhook code. I add ${origin}/api/webhooks/lemonsqueezy/${site.id} in Lemon Squeezy myself.

### Polar
- buy.polar.sh links on the page need no change, because the script adds reference_id=rtv_<visitor id> unless the link has its own.
- Checkouts created with the API: metadata: { ...existingMetadata, rt_visitor_id: rt.rt_visitor_id ?? '', rt_session_id: rt.rt_session_id ?? '' }.
- Do not add webhook code. I add ${origin}/api/webhooks/polar/${site.id} in Polar myself.

### Paddle Billing
- Where the code calls Paddle.Checkout.open, add customData: { ...existingCustomData, ...(window.founderdata?.attribution?.() ?? {}) }. Server-created transactions get the same keys in custom_data.
- Do not add webhook code. I add ${origin}/api/webhooks/paddle/${site.id} in Paddle myself.

### Gumroad
- gumroad.com/l/... and *.gumroad.com links on the page need no change, because the script adds rt_visitor_id and rt_session_id as URL parameters. Links opened from JavaScript need ?rt_visitor_id=<id>&rt_session_id=<id> appended.
- I set the Gumroad ping URL from the site's settings in FounderData myself.

### Any other provider (your own billing, or one FounderData has no webhook for)
- Pass the ids into the provider's custom data or metadata the same way, so they come back in its webhook.
- In the server code that already handles that provider's "payment succeeded" webhook, add a call to FounderData:
    POST ${origin}/api/v1/payments with headers Authorization: Bearer <FOUNDERDATA_API_KEY> and Content-Type: application/json
    body: { "transaction_id": "<the provider's payment id>", "amount": 29.99, "currency": "${site.currency}", "visitor_id": "<rt_visitor_id from the metadata>", "session_id": "<rt_session_id>", "email": "<buyer email>" }
  For a refund, send the same transaction_id with "refunded": true. Read the key from an environment variable named FOUNDERDATA_API_KEY and tell me to set it; the key is in the site's settings in FounderData. Never hardcode it, and never let a failed call to FounderData fail the provider's webhook.

## Task 3: identify logged-in users
Right after a successful login or signup, and on app load when a user session exists, call:
  window.founderdata?.('identify', { user_id: user.id, email: user.email, name: user.name })
This links anonymous visits to the person. FounderData also uses the email to attribute a payment that arrives without ids.

## Task 4: track the key buttons as goals
Add a data attribute to the main calls to action. No JavaScript is needed. Use short snake_case names:
  <button data-rt-goal="signup_click">, data-rt-goal="start_trial", data-rt-goal="pricing_cta", data-rt-goal="checkout_click"
Optional details go in extra attributes: data-rt-goal-plan="pro". From code: window.founderdata?.('goal', 'signup_completed', { plan: 'pro' }).
Track at least the main signup or get-started buttons, the plan buttons on the pricing page and the checkout or buy button. Also fire window.founderdata?.('goal', 'signup_completed') after a successful signup.

## TypeScript
If the project uses TypeScript, add a global declaration so the calls type-check:
  declare global { interface Window { founderdata?: ((cmd: 'goal' | 'identify' | 'pageview' | 'consent', a?: any, b?: any) => void) & { attribution?: () => { rt_visitor_id?: string; rt_session_id?: string; rt_site_id?: string } } } }
Always call it with optional chaining (window.founderdata?.(...)), so a blocked script never breaks a page.

## Rules
- Keep the changes small and in the existing code style. Leave unrelated code alone.
- Hardcode no secrets. This setup needs none.
- The script ignores localhost. To test locally, add data-allow-localhost to the script tag for the test and remove it before you commit, or test on the deployed site.

## When you are done, reply with
1. Every file you changed, and why.
2. Which payment providers you found, which checkout and payment code paths now send the FounderData ids, and any you could not find or were unsure about.
3. Which webhooks, settings or environment variables I still have to set up myself.
4. Which goals you added, and where.
5. How I can check it: open the site, and in DevTools, Network, a POST to ${origin}/api/event returns 202. The visit shows up in my FounderData dashboard within seconds.`;
}


/**
 * The prompt for an iOS app without a website: the bundle id first, then the Swift package, purchases (StoreKit or
 * RevenueCat) and goals, following ios/README.md. No script tag, no web checkout. Like the web prompt it holds no secret.
 */
export function buildAppPrompt(site: Site, origin: string): string {
  const bundle = site.app_bundle_id;
  return `Set up FounderData analytics and revenue attribution in this iOS app. FounderData is my own analytics service. Make the changes directly in the code. Ask me only what you cannot find out by reading the project, and ask all of it at once before you change anything.

## My FounderData values (correct as written, use them unchanged)
- Bundle id: ${bundle ?? 'not set yet. Read it from the app target (PRODUCT_BUNDLE_IDENTIFIER) and tell me, so I add it to the site in FounderData. The server refuses app events until it matches.'}
- Site id: ${site.id}
- Host: ${origin}
- Revenue currency: ${site.currency}

## Task 1: add the SDK
- Check that the app target's bundle id is ${bundle ?? 'the one in FounderData'}. If it differs, stop and tell me.
- Add the Swift package https://github.com/founderdata/founderdata and link the product FounderDataKit to the app target.
- In the App's init, call FounderData.configure(siteId: "${site.id}", host: "${origin}"), then FounderData.observeTransactions().
- On the root view, add .onOpenURL { FounderData.handle(url: $0) } so links can carry campaign data.
- Name the main screens with .founderDataScreen("Settings") or FounderData.screen("Settings"). Use stable names, not localized titles.
- On sign-out, call FounderData.reset().

## Task 2: purchases (the most important task)
First find out how the app sells: search for "Purchases.configure", "RevenueCat", "product.purchase", "StoreKit", "Transaction.updates". Then do the part that fits and skip the other.

### StoreKit 2
- Buy with try await FounderData.purchase(product, source: .onboarding) (or .settings, .featureGate: where the paywall opened). It adds the app account token, sends the purchase goals and reports the verified transaction.
- Code that calls product.purchase itself adds .appAccountToken(FounderData.appAccountToken) to the options and passes a verified result to FounderData.track(purchase:).
- I point App Store Server Notifications V2 at ${origin}/api/webhooks/apple/${site.id} in App Store Connect myself. If a backend already receives them, forward the raw body there unchanged instead, and tell me where.

### RevenueCat
- Right after Purchases.configure, call Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes).
- Set the same attributes again after Purchases.shared.logIn, after FounderData.reset() and before each purchase. The id changes at those points.
- Wrap each purchase: try await FounderData.trackPurchase(product: package.storeProduct.productIdentifier, source: source) { let r = try await Purchases.shared.purchase(package: package); return r.userCancelled ? .cancelled : .purchased }
- I add the webhook ${origin}/api/webhooks/revenuecat/${site.id} in RevenueCat myself. Skip App Store Server Notifications in this case.

## Task 3: the paywall and onboarding
- When a paywall appears, call FounderData.paywallViewed(source: .onboarding) with the source that opened it.
- At each onboarding step call FounderData.onboardingStep(1, "welcome"), FounderData.onboardingStep(2, "name") and so on, in the order the user sees them, and FounderData.onboardingComplete() at the end.
- After sign-in, call FounderData.identify(userId: user.id, email: user.email, name: user.name).

## Rules
- Keep the changes small and in the existing code style. Leave unrelated code alone.
- Hardcode no secrets. This setup needs none.
- Debug builds may pass debugHost: "http://localhost:8787" to configure. Release builds always use the host above.

## When you are done, reply with
1. Every file you changed, and why.
2. How the app sells (StoreKit or RevenueCat) and which purchase paths now go through FounderData.
3. What I still have to set up myself: the bundle id in FounderData, the App Store notification URL or the RevenueCat webhook.
4. How I can check it: run the app in the Simulator. The first app session shows up in my FounderData dashboard within seconds.`;
}
