# Polar

## Unlocks

Revenue per visitor and source from Polar orders, refunds and subscriptions. Steps `payments:<site>`, then
`attribution:<site>`.

## Cost

Free.

## Needs

- A Polar organization (the live one: Polar's sandbox sends no test flag, so connect only live). The human signs in (STOP).
- `buy.polar.sh` links need no code (the tracker adds `reference_id=rtv_<visitor id>`). API checkouts need
  `metadata: { ...existing, rt_visitor_id, rt_session_id }` (`install.md`, row "Polar").
- No webhook CLI or API route is documented here. Labels come from `docs/GUIDE.md`, "Revenue attribution with Lemon Squeezy,
  Polar, Paddle and Gumroad", and were not re-checked against Polar's current UI.

## Fastest path: browser  [browser, you]

1. `agent-browser --headed --session founderdata open https://polar.sh`. **STOP** for sign-in.
2. Organization **Settings, Webhooks**, add an endpoint with the URL `ORIGIN/api/webhooks/polar/SITE_ID` and format **Raw**.
3. Events: `order.paid`, `order.refunded`, `subscription.created`, `subscription.updated`, `subscription.canceled`,
   `subscription.revoked`.
4. Save. **STOP**: the human copies the endpoint's secret into the page `npm run connect` opens. FounderData accepts the
   signature made before and since Polar's September 2026 signing change.

## Connect command

```bash
npm run connect -- polar --site SITE_ID
```

## Verify

`payments:<site>` `waiting`, then `done` on the first live order. `attribution:<site>` `done` when an order links to a visit.

## What wrong looks like

- "Webhooks refused": wrong secret, or the endpoint format is not Raw.
- Orders arrive from the sandbox organization: they carry no flag and would count. Remove that endpoint (the human does).
