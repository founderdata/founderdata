# Stripe

## Unlocks

Revenue per visitor and per source: every Stripe payment, refund, dispute and subscription change, tied to the visit that
brought the buyer. Steps `payments:<site>` then `attribution:<site>`.

## Cost

Free. Stripe charges nothing for webhooks.

## Needs

- A Stripe account, live mode activated. The human signs in (STOP).
- Checkout code that passes the visitor ids (`skills/founderdata-setup/references/install.md`, table row "Stripe").
- The Stripe CLI (<https://docs.stripe.com/cli/install>). Check `stripe version`.
- One endpoint per FounderData site, even when several sites share one Stripe account. Each endpoint has its own secret.

## Fastest path: the CLI creates the endpoint  [agent, you at login]

Stripe's docs name the CLI and API as the way to create an endpoint without clicking
(<https://docs.stripe.com/api/webhook_endpoints/create>, <https://docs.stripe.com/webhooks>). The CLI's own help lists
`stripe webhook_endpoints create` with `--url`, `--enabled-events` (repeatable), `--description`, `--live` and `--dry-run`
(checked against CLI 1.50.0). This route makes a classic (snapshot) endpoint, which is the payload FounderData reads. The
dashboard defaults to a Thin payload, so the dashboard path below has a trap this one avoids.

1. Sign in. `stripe login --non-interactive` prints JSON with a `browser_url`, a `verification_code` and a `next_step`
   command, and exits. Show the human the URL and the code. **STOP**: they approve in the browser. Then run the
   `next_step` command to finish.
2. Show the plan, then a dry run (nothing is created):

   ```bash
   stripe webhook_endpoints create --live --dry-run --url ORIGIN/api/webhooks/stripe/SITE_ID \
     --description "FounderData SITE_ID" \
     --enabled-events checkout.session.completed --enabled-events checkout.session.async_payment_succeeded \
     --enabled-events invoice.paid --enabled-events invoice_payment.paid \
     --enabled-events payment_intent.succeeded --enabled-events charge.succeeded \
     --enabled-events charge.refunded --enabled-events refund.created \
     --enabled-events refund.updated --enabled-events refund.failed \
     --enabled-events charge.dispute.created --enabled-events charge.dispute.closed \
     --enabled-events customer.subscription.created --enabled-events customer.subscription.updated \
     --enabled-events customer.subscription.deleted --enabled-events invoice.payment_failed
   ```

   The list is the table in `docs/GUIDE.md`, "Revenue attribution with Stripe", which wins if they differ. What each
   event does is in that table. Leaving out `invoice_payment.paid` breaks subscription refunds.
3. Create it for real and keep the response away from yourself. The answer holds the signing secret (`secret`, starts
   `whsec_`), which Stripe returns on creation ("Returns the webhook endpoint object with the `secret` field populated").
   Write the answer to a private file, move the secret to its own file, and show only the safe fields:

   ```bash
   umask 077; D=$(mktemp -d)
   stripe webhook_endpoints create --live --url ORIGIN/api/webhooks/stripe/SITE_ID \
     --description "FounderData SITE_ID" <the same --enabled-events flags as the dry run> > "$D/r.json"
   node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],r.secret);console.log(r.id,r.status,r.livemode)' "$D/r.json" "$D/secret"
   rm "$D/r.json"
   npm run connect -- stripe --site SITE_ID --file "$D/secret" --delete-file
   rmdir "$D"
   ```

   Expect `we_... enabled true` and then `{"ok":true,"provider":"stripe","set":[...]}`. No paste page is needed, because the
   value never reaches your context. If `--file` is not accepted for `stripe`, fall back to the paste page: the human opens
   the endpoint in Stripe and copies the secret (see the browser path, step 6).
4. A permission error means the CLI login's key cannot write webhook endpoints (not confirmed for the browser-login key).
   Use the browser path.

## Browser path  [browser, you]

Dashboard steps from <https://docs.stripe.com/webhooks#webhooks-summary>:

1. `agent-browser --headed --session founderdata open https://dashboard.stripe.com/webhooks`. **STOP** for sign-in and 2FA.
2. Workbench, **Webhooks** tab, **Create an event destination**. Select **Your account**.
3. **Payload format: choose Snapshot**, not Thin. Pick the API version Stripe offers for snapshot.
4. Select the events from the list in step 2 of the CLI path (the search box takes each name).
5. **Continue**, destination type **Webhook endpoint**, **Continue**, endpoint URL `ORIGIN/api/webhooks/stripe/SITE_ID`,
   description `FounderData SITE_ID`. Create.
6. The settings page shows a signing secret `whsec_...`. **STOP**: the human clicks **Reveal secret** and copies it. Run
   `npm run connect -- stripe --site SITE_ID` and they paste it into the page. Take no screenshot while it is revealed.

## Connect command

```bash
npm run connect -- stripe --site SITE_ID
```

The page checks the `whsec_` format and stores it as the site's Stripe signing secret.

## Verify

- `payments:<site>`: `waiting` ("Webhook set. Waiting for the first payment") right after connect. `done` once a payment
  arrives through the endpoint.
- `attribution:<site>`: `done` only when a payment links to a visit. Payments with no link show as a count in `evidence`.
- To get the first signal now, the human makes one cheap purchase through the real checkout and refunds it. That spends
  real money, so it needs a yes.
- Optional history: **Settings, Stripe, Import past payments** takes a restricted key with read access to Charges and
  Invoices (`rk_live_...`). The human pastes it in the dashboard field, not through connect. FounderData deletes it
  within an hour.

## What wrong looks like

- Step `broken` or the "Webhooks refused" alert: a bad signature. The secret belongs to another endpoint, or to test
  mode when the endpoint is live. Each endpoint and each mode has its own secret. Redo connect with the right one.
- Deliveries show 200 but no payment appears: a Thin endpoint, or `checkout.session.completed` missing. Check the event
  list and the payload format in Workbench.
- Payments arrive but `attribution` stays `waiting` with "none linked": the checkout does not send `rt_visitor_id` in
  metadata. Fix the code (`install.md`). Several sites on one account need `rt_site_id` in the metadata too.
- Everything on the wrong site: see "Several sites on one Stripe account" in `docs/GUIDE.md`.
