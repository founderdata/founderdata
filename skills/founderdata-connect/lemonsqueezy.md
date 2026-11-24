# Lemon Squeezy

## Unlocks

Revenue per visitor and source from Lemon Squeezy orders, refunds and subscriptions. Steps `payments:<site>`, then
`attribution:<site>`.

## Cost

Free.

## Needs

- A Lemon Squeezy store. The human signs in (STOP).
- Checkout links on the pages need no code: the tracker adds `checkout[custom][rt_visitor_id]`, `rt_session_id` and
  `rt_site_id`. API-made checkouts need `checkout_data.custom` (`install.md`, row "Lemon Squeezy").
- No webhook CLI or API route is documented here. The labels below come from `docs/GUIDE.md`, "Revenue attribution with
  Lemon Squeezy, Polar, Paddle and Gumroad", and were not re-checked against Lemon Squeezy's current UI.

## Fastest path: browser  [browser, you]

Lemon Squeezy has the human type the signing secret themselves, so they choose it. FounderData signs nothing here.

1. `agent-browser --headed --session founderdata open https://app.lemonsqueezy.com/settings/webhooks`. **STOP** for sign-in.
2. Add a webhook with the URL `ORIGIN/api/webhooks/lemonsqueezy/SITE_ID`.
3. Select these events: `order_created`, `order_refunded`, `subscription_created`, `subscription_updated`,
   `subscription_cancelled`, `subscription_expired`, `subscription_payment_success`, `subscription_payment_failed`,
   `subscription_payment_refunded`.
4. **STOP** at the signing secret field: the human invents a long random string (a password manager generates one), types
   it there, and pastes the same string into the page `npm run connect` opens. Do not type it yourself.
5. Save. Use the live store, not test mode: events with `test_mode` are ignored.

## Connect command

```bash
npm run connect -- lemonsqueezy --site SITE_ID
```

## Verify

`payments:<site>` `waiting`, then `done` on the first live order. `attribution:<site>` `done` when an order links to a
visit.

## What wrong looks like

- "Webhooks refused": the two copies of the secret differ. Repeat step 4 and connect again.
- Nothing arrives: the endpoint is on a test-mode store (ignored), or an event is not ticked.
- Several sites on one store: each payment lands on the site named in `rt_site_id`, else the first that receives it.
