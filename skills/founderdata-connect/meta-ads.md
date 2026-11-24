# Meta ads (Pro)

## Unlocks

Spend per ad and day, ROAS and cost per customer next to the customers and revenue FounderData credited, plus the
Conversions API so a campaign can optimize for buyers. Step id `meta:<site>`. Needs a `pro/` folder.

## Cost

Free. Meta charges for the ads, not for the token. Importing spend writes D1 rows only.

## Needs

- A Meta Business account that owns the ad account. The human signs in (STOP).
- Source for everything below: `docs/GUIDE.md`, "Set up Meta ads". Business settings labels change often, so snapshot each
  page. Your own ad account needs no App Review.

## Fastest path  [browser, you]

1. `agent-browser --headed --session founderdata open https://business.facebook.com/settings`. **STOP** for sign-in and 2FA.
2. Accounts, **Apps**: add an app with the Marketing API product.
3. **Users, System users**: add one with the **Employee** role. Assign three assets: the app (Manage app), the ad account
   (View performance is enough) and, for the Conversions API, the dataset (Manage).
4. **Generate token**: pick the app, expiry **Never**, permission `ads_read`. It covers the spend import and the Conversions
   API. **STOP**: the token shows once, and the human copies it.
5. `npm run connect -- meta-ads` opens the paste page for `META_ACCESS_TOKEN` and the optional `META_APP_SECRET`
   (adds `appsecret_proof` to every call).
6. In each site's Settings, **Meta ads**, the **human** picks the ad account from the list the token can read. When several
   products share one ad account, they enter text only this product's campaign names contain (`ACME`).
7. [browser, you] Ads Manager, each ad, Tracking, URL parameters: paste
   `utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{placement}}&ad_id={{ad.id}}`.
   Editing live ads changes a customer's campaigns: show the list of ads and get a yes first. Settings has a copy button.
8. [agent] Test each landing page with `?ad_id=1234567890123&fbclid=test123456789`, then look at the visit in Realtime. A
   redirect that drops the query string loses the ad id.
9. Targets (target CPA and break-even ROAS) are the human's numbers in the site's Settings.

## Connect command

```bash
npm run connect -- meta-ads
```

## Verify

`meta:<site>`: `waiting` after the first import is queued, `done` when spend rows and visits with an ad id exist. The **Launch
check** card on the Meta ads tab, and `launch` in the API, say which item is open: token, account status, fresh import,
timezone, visits with an ad id in the last 24 hours, the share of payments linked to a visit, the Conversions API. One real
purchase with a test ad id (and a refund) proves the checkout: it spends money, so ask first.

## What wrong looks like

- Import error: the token lacks `ads_read`, the system user lacks an asset, or the token has an expiry that passed.
- Clicks counted by Meta but no visit has an ad id: URL parameters are missing, or a boosted post (it gets none: its visits
  land in "No ad id").
- Spend and visits a day apart: the site's timezone differs from the ad account's. The tab says so.
