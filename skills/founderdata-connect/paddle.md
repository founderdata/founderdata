# Paddle Billing

## Unlocks

Revenue per visitor and source from Paddle transactions, adjustments (refunds, chargebacks) and subscriptions. Steps
`payments:<site>`, then `attribution:<site>`.

## Cost

Free.

## Needs

- A Paddle Billing account, live. Paddle's sandbox is a separate account that sends no test flag: connect only the live
  destination. The human signs in (STOP).
- Paddle's overlay checkout opens from code, so the code change is required: `customData` on `Paddle.Checkout.open`, and
  `custom_data` on server-made transactions (`install.md`, row "Paddle Billing").
- No webhook CLI or API route is documented here. Labels come from `docs/GUIDE.md` and were not re-checked against
  Paddle's current UI.

## Fastest path: browser  [browser, you]

1. `agent-browser --headed --session founderdata open https://vendors.paddle.com`. **STOP** for sign-in.
2. Developer tools, **Notifications**, add a destination of type webhook with the URL
   `ORIGIN/api/webhooks/paddle/SITE_ID`.
3. Events: `transaction.completed`, `adjustment.created`, `adjustment.updated`, `subscription.created`,
   `subscription.updated`, `subscription.canceled`, `subscription.past_due`.
4. Save. **STOP**: the human copies the destination's secret key into the page `npm run connect` opens.

## Connect command

```bash
npm run connect -- paddle --site SITE_ID
```

## Verify

`payments:<site>` `waiting`, then `done` on the first live transaction. `attribution:<site>` `done` when one links to a
visit. A refund counts once Paddle approves the adjustment.

## What wrong looks like

- "Webhooks refused": the secret is another destination's, or the sandbox's.
- Payments with no visit: the checkout passes no `customData`. Fix the code.
