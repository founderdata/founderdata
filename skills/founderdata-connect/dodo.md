# Dodo Payments

## Unlocks

Revenue per visitor and source from Dodo payments, refunds and subscription events. Steps `payments:<site>`, then
`attribution:<site>`.

## Cost

Free.

## Needs

- A Dodo Payments account. The human signs in (STOP).
- Checkout code that sends the visitor ids as metadata, and a return URL on the site (`skills/founderdata-setup/references/install.md`, row "Dodo").
- No CLI or API route for webhooks is documented in this repository. The path is the dashboard. The click path below comes from `docs/GUIDE.md`, "Revenue attribution with Dodo Payments", and was not re-checked against Dodo's current UI.

## Fastest path: browser  [browser, you]

1. `agent-browser --headed --session founderdata open https://app.dodopayments.com`. **STOP** for sign-in.
2. Developer, **Webhooks**, add an endpoint with the URL `ORIGIN/api/webhooks/dodo/SITE_ID`.
3. Subscribe to these events: `payment.succeeded`, `refund.succeeded`, `subscription.active`, `subscription.renewed`,
   `subscription.plan_changed`, `subscription.on_hold`, `subscription.cancelled`, `subscription.expired`,
   `subscription.failed`. Without the subscription events a yearly plan counts its full price as MRR until the second
   payment (`docs/GUIDE.md`).
4. Save. The endpoint shows a signing secret `whsec_...`. **STOP**: the human reveals and copies it, then pastes it into
   the page `npm run connect` opens. Take no screenshot while it shows.
5. Set each checkout's return URL to a page that loads the tracker (`/thanks`). Dodo adds `?payment_id=` and FounderData
   uses it to link a payment when the metadata is lost. This is a code change (`install.md`), not a console one.

## Connect command

```bash
npm run connect -- dodo --site SITE_ID
```

## Verify

`payments:<site>` is `waiting` after connect and `done` on the first payment through the endpoint. `attribution:<site>`
is `done` when one payment links to a visit. The Customers tab shows how each payment matched. A test purchase spends real
money: ask first.

## What wrong looks like

- "Webhooks refused" alert or a `broken` step: the signing secret does not match this endpoint. Connect again.
- Payments with no visit: metadata missing and no return URL. Fix the checkout code.
- A yearly plan counting too much MRR: the subscription events are not subscribed.
