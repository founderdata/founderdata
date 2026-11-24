# Cloudflare token (Pro: Mail and recordings)

## Unlocks

- Mail: with an API token and the account id, the Mail page sets a domain up for you (Email Sending, Email Routing, the
  catch-all rule, delivery events), shows each DNS record's state and keeps the suppression list in step with
  Cloudflare's. Mail sends and receives without the token, but those parts stay manual (`docs/MAIL.md`, "Set it up").
- Recordings: R2 storage for visit recordings, made by `npm run setup -- --replay` (no token needed).

Needs a `pro/` folder. Step ids: `mail`, `recordings` (assumed: the real ids are in `get_setup`).

## Cost

Mail needs Cloudflare **Workers Paid** (`docs/GUIDE.md`, "Set up integrations") and a domain whose DNS is on the same
Cloudflare account. Cloudflare bills it, FounderData adds nothing. Show the plan price in the plan and wait for a yes. R2
for recordings has its own storage price: say so and cap nothing yourself.

## Needs

- The human's Cloudflare login (they already did `wrangler login`).
- The account id: not a secret. `npx wrangler whoami` prints it.
- An API token. Creating tokens is the one Cloudflare action only the human does, in the dashboard.

## Fastest path

1. [agent] Run `npm run setup -- --mail` (creates the R2 bucket and the queue named `<database name>-mail`, writes their
   bindings into `wrangler.local.jsonc`, deploys). `--replay` does the same for recordings. Ask before each, because they
   add billable Cloudflare resources.
2. [browser, you] Create the token. `agent-browser --headed --session founderdata open https://dash.cloudflare.com/profile/api-tokens`
   (an account-level token page also exists under Manage Account). **STOP** for sign-in and 2FA. **Create Token**, name it
   `FounderData mail`, start from a custom policy
   (<https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>). Permissions per `docs/MAIL.md`: it
   reads the zone and the account's analytics, and edits Email Sending, Email Routing and Queues. The exact permission
   names are not in the repository: pick the entries with those names, and let a failing Domains-tab step quote
   Cloudflare's error, which names the missing permission. The secret shows once. **STOP**: the human copies it.
3. [agent] `npm run connect -- cloudflare` opens the paste page for `CLOUDFLARE_API_TOKEN` and asks for
   `CLOUDFLARE_ACCOUNT_ID`.
4. [you] In the dashboard, **Mail, Domains**, add the domain and pick sending, receiving or both. The DNS records appear in
   a zone Cloudflare hosts. You do not edit DNS.

## Connect command

```bash
npm run connect -- cloudflare
```

## Verify

The Domains tab reads each record as **verified**. A test message from **New message** to a mailbox the human owns arrives,
and the reply lands in the same thread.

## What wrong looks like

- A Domains step fails and quotes Cloudflare: the token lacks the permission it names. The human adds that permission to
  the token (you never change a token's permissions).
- Mail pages say which piece is missing: `--mail` was not run, or the domain's DNS is on another account.
