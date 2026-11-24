# Gumroad

## Unlocks

Revenue per visitor and source from Gumroad sales, refunds and cancellations. Steps `payments:<site>`, then
`attribution:<site>`.

## Cost

Free.

## Needs

- A Gumroad account. The human signs in (STOP).
- `gumroad.com/l/...` and `*.gumroad.com` links need no code: the tracker adds `rt_visitor_id` and `rt_session_id`. A link
  opened from JavaScript needs them appended (`install.md`, row "Gumroad").
- Gumroad signs nothing. FounderData puts a random token in the ping URL, and anyone who learns the URL can post fake
  sales. **The ping URL is a secret.** `scripts/setup-sites.mjs` prints it to stdout when a site has `gumroad_seller_id` or
  `"gumroad": true`, so leave those keys out of `sites.json` during setup and have the human take the URL from the
  dashboard.
- Source: `docs/GUIDE.md`, "Revenue attribution with Lemon Squeezy, Polar, Paddle and Gumroad". The Gumroad menu labels
  there were not re-checked against Gumroad's current UI.

## Fastest path: the human, in two places  [you]

Nothing here needs you to touch the URL or Gumroad's token.

1. In FounderData, open the site's **Settings, Payments, Gumroad**, turn it on (the human may type their seller id, or the
   first sale sets it) and copy the ping URL. **New URL** there turns the old one off.
2. In Gumroad, **Settings, Advanced**, paste it as the Ping URL. That sends sales only.
3. For refunds and cancellations, add the same URL as a resource subscription for `refund`, `cancellation` and
   `subscription_ended`. The loop is in `docs/GUIDE.md` and needs the human's Gumroad access token, so the human runs it
   in their own terminal.

You stay out of both steps. Your job is to confirm the result.

## Connect command

None: the token is created and shown by FounderData, not pasted.

## Verify

`payments:<site>` is `waiting` until the first sale arrives with the token and seller id, then `done`. `attribution:<site>`
`done` when a sale links to a visit. Gumroad sales with `test=true` are ignored.

## What wrong looks like

- Sales never arrive: the URL was pasted incomplete, or **New URL** was pressed after pasting. Copy it again.
- Refunds missing: step 3 was skipped.
- Fake sales: the URL leaked. The human presses **New URL** and repeats step 2.
