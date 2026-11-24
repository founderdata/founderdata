# Email alerts (Resend or Cloudflare) and Resend stats

## Unlocks

Payment, refund, failed-renewal and weekly-report alerts by email. Step `email`. Pro adds per-site email stats from Resend
(sent, delivered, bounced, opened) through a second secret.

## Cost

Free. Resend's free tier covers alert volume (check Resend's pricing page). Cloudflare Email Routing is free and sends only
to addresses the human verified.

## Needs

Pick one sender route with the human. Source: `docs/GUIDE.md`, "Alerts and weekly report".

| Route | Sends to | Needs |
| --- | --- | --- |
| Resend | any address | a Resend account with a verified domain, an API key, a sender like `FounderData <alerts@acme.example>` |
| Cloudflare Email Routing | the human's verified addresses | Email Routing on a domain in the same Cloudflare account, a `send_email` binding, a sender on that domain |

## Fastest path: Resend  [browser, you]

1. `agent-browser --headed --session founderdata open https://resend.com/api-keys`. **STOP** for sign-in. The domain must be
   verified under Domains (DNS records: the human adds them, you never change DNS).
2. Create an API key named `FounderData alerts` with **Sending access**. The key shows once. **STOP**: the human copies it.
3. `npm run connect -- resend` opens the paste page for `RESEND_API_KEY`. It asks for the sender too
   (`ALERT_EMAIL_FROM`, `FounderData <alerts@acme.example>`), which is not secret.
4. The human opens the dashboard, **Notifications**, adds an **Email** channel with their address and presses **Send**,
   then picks the test message. You cannot do this step without typing the admin password into a browser, so you do not.

## Fastest path: Cloudflare Email Routing  [agent, you]

1. **STOP**: the human turns on Email Routing for the domain (Cloudflare, the domain, Email, Email Routing) and confirms the
   destination address from the link Cloudflare emails.
2. [agent] Add to `wrangler.local.jsonc` (gitignored, the deployment's own config):

   ```jsonc
   "send_email": [{ "name": "EMAIL" }],
   "vars": { "ALERT_EMAIL_FROM": "FounderData <alerts@acme.example>" }
   ```

   Then `npm run setup` to deploy. The sender must be an address on that domain.
3. The human adds the Email channel and presses **Send** as above.

## Resend stats (Pro)  [browser, you]

One webhook per Resend account covers every site.

1. Resend, **Webhooks**, **Add webhook**, URL `ORIGIN/api/webhooks/resend`.
2. Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.opened`,
   `email.clicked`.
3. **STOP**: the human copies the signing secret `whsec_...` into `npm run connect -- resend --stats`
   (assumed flag: confirm with `npm run connect -- --help`; the secret is `RESEND_WEBHOOK_SECRET`).
4. Opens and clicks read Off until Resend sends the first event. Open and click tracking is a switch on the domain's page in
   Resend. FounderData never changes it.

## Connect command

```bash
npm run connect -- resend
```

## Verify

`get_setup` `email`: `done` after a test alert is sent and accepted. `GET /api/alerts` returns `email: true` and `email_via`
(`resend` or `cloudflare`). The human confirms the message arrived.

## What wrong looks like

- Send test says the sender is refused: the sender's domain is not verified in Resend, or it is off the Email Routing domain.
- Cloudflare refuses an address: it is not verified as a destination.
- `email_via: null`: the key or the sender is missing. Run connect again.
