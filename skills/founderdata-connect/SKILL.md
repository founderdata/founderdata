---
name: founderdata-connect
description: Use when a FounderData setup step needs a third-party account connected, such as a payment webhook (Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, RevenueCat, App Store), Search Console, DataForSEO, AI engine keys, Resend, Meta ads, X, Apple Search Ads, App Store Connect sales or Cloudflare mail. Pick the provider file, follow it, and pass secrets only through the paste page.
---

# Connect a provider to FounderData

One file per provider sits beside this one. Each has the same parts: what it unlocks, cost, needs, the fastest path (CLI or
API first, then browser), the STOP points, the connect command, how to verify and what wrong looks like.

Read `skills/founderdata-browser/SKILL.md` first if you have not this run. The rule that matters most here: **a secret never
passes through you.** It goes from the provider's page into the paste page that `npm run connect` opens.

## Pick the file

Find the step in `get_setup` (or `npm run doctor -- --json`): its `skill` field names the file. Without it, use the table.
Pro rows need a `pro/` folder. In core they are `locked`: tell the human what they unlock and stop.

| Provider | File | Unlocks | Cost | Edition |
| --- | --- | --- | --- | --- |
| Stripe | `stripe.md` | revenue per visitor and source | free | core |
| Dodo Payments | `dodo.md` | the same | free | core |
| Lemon Squeezy | `lemonsqueezy.md` | the same | free | core |
| Polar | `polar.md` | the same | free | core |
| Paddle | `paddle.md` | the same | free | core |
| Gumroad | `gumroad.md` | the same | free | core |
| RevenueCat | `revenuecat.md` | app subscription revenue per install | free | core |
| App Store (notifications) | `app-store.md` | app purchases, renewals, refunds; SDK install in Xcode | free | core |
| Resend or Cloudflare mail | `resend.md` | alerts and the weekly report by email | free tier | core (stats: Pro) |
| Cloudflare token | `cloudflare.md` | Mail domains, recordings storage | Workers Paid for mail | Pro |
| Search Console | `google-search-console.md` | clicks, queries, pages, decay | free | Pro |
| DataForSEO | `dataforseo.md` | Google ranks, keyword research, App Store ranks | prepaid balance, capped | Pro |
| AI engines | `ai-engines.md` | how often assistants name the site | per check, capped | Pro |
| Meta ads | `meta-ads.md` | spend, ROAS, Conversions API | free | Pro |
| X | `x.md` | visitors and revenue per post | X bills reads | Pro |
| Apple Search Ads | `apple-search-ads.md` | ad spend and ROAS for installs | free | Pro |
| App Store Connect sales | `app-store-connect.md` | downloads, proceeds, Apple's cut | free | Pro |

## The protocol  (every provider)

1. **State.** `get_setup`: is the step already `done`? Then stop. `broken`? Read "what wrong looks like" first.
2. **Plan.** Name the account, what you create (endpoint, key, client), the events or scopes, the cost, and the STOP
   points. Wait for yes. A cost line is not optional for a Pro provider.
3. **Fast path.** Use the CLI or API when the file has one. Otherwise drive the console with `agent-browser`.
4. **STOP.** At sign-in, 2FA, a CAPTCHA and the secret itself, hand over (browser skill, "When the human has to act").
5. **Connect.** Run the file's `npm run connect` command. It opens a local page on 127.0.0.1 that names the provider, links
   the page where the value lives, and has one password field. The human pastes. Your stdout gets only
   `{"ok":true,"provider":"...","set":["NAME"],"verified":true|false}`. The page closes after one submit or 10 minutes.
6. **Verify.** Poll `get_setup` for the step's expected status. `waiting` is correct until the first real event. Say which
   event ends the wait.
7. **Log** with `fd_log`.

## Connect command reference

```bash
npm run connect -- <provider> --site SITE_ID     # paste page, the default
npm run connect -- <provider> --stdin            # the human types the value hidden, in the terminal
npm run connect -- <provider> --file <path> [--delete-file]   # a value in a file, such as a .p8
npm run connect -- <provider> --watch-downloads  # waits for AuthKey_*.p8 in the Downloads folder
npm run connect -- generate <provider>           # FounderData makes the secret (RevenueCat), shows it once on the page
```

`<provider>` is the file name without `.md`, and `npm run connect -- --help` lists the registry's ids if one differs.
`--site` applies to per-site secrets and settings. Deployment-wide secrets (DataForSEO, AI engines, Meta, X, Cloudflare,
Resend) omit it. Exit codes are 0 done, 1 something to do, 2 needs input, 3 needs the human, 4 error.

When the human cannot use a paste page (a remote machine), use `--stdin`. A value never goes in your command line, a
chat message or a file you read.

## Secrets that never go through connect

Some values are dashboard fields by design: Stripe's history-import key (pasted into the Stripe card in Settings, and
deleted by FounderData within an hour). Those files say "the human pastes it in the dashboard" and give the exact field.
