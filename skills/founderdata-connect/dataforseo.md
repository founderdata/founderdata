# DataForSEO (Pro)

## Unlocks

Google rank tracking and keyword research (SEO tab), App Store ranks without a Mac (ASO tab), and Google AI Overviews and
Perplexity checks (AI visibility tab). Step id `dataforseo`. Needs a `pro/` folder.

## Cost

The owner pays DataForSEO directly from a prepaid balance. FounderData adds nothing. Every price in the docs is an
unverified estimate (`docs/SEO.md`, "Cost"): a one-row keyword suggestion call is about $0.0101, a Google rank check about
$0.0006 to $0.0012 per keyword, and AI Overviews add about $0.002 a check. One monthly cap per
site covers all of it, and a cap of $0 stops everything. **Spending needs a yes with the balance and the cap.**

## Needs

- A DataForSEO account with a balance. The human signs up and tops up (STOP, it is a payment).
- The **API login** and **API password** from DataForSEO's dashboard. The API password is a different string from the
  account password (`docs/GUIDE.md`, "Set up integrations").

## Fastest path  [browser, you]

1. `agent-browser --headed --session founderdata open https://app.dataforseo.com`. **STOP** for sign-up or sign-in, and for
   the balance top-up. You never enter payment details.
2. The API access page shows the login and the API password. **STOP**: the human copies both into the paste page.
3. `npm run connect -- dataforseo` stores `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`. Run it with no `--site`: one login
   serves every site.
4. Test the login. The checklist's test calls DataForSEO's `/appendix/user_data`, which should cost nothing (not confirmed
   with DataForSEO). Tell the human to check their usage after: `POST /api/setup/test/dataforseo` with the owner login, or the
   Test button on the checklist's DataForSEO row. The 15-second gap between presses applies.
5. Per site, the country, device and monthly cap are set by the **human** in the SEO tab, Google ranks. Only the dashboard
   login changes them, by design: a key can spend money but cannot raise the cap (`docs/API.md`, "Ranks and keyword
   research"). Agree the cap in the plan, then have them type it.
6. [agent] Add keywords with a key that has `research:write`: `POST /api/v1/ranks/keywords` with `{"keywords":[...]}`
   (200 at most, `?site=SITE_ID` for a multi-site key), or the MCP tool `research_keywords` with `track`. Buying keyword
   research needs `spend:seo`, which is a separate yes.

## Connect command

```bash
npm run connect -- dataforseo
```

## Verify

`dataforseo`: `done` once the test says the login works with a balance. The first rank for a new keyword arrives about 15
minutes after it is added (the cron runs every 5 minutes), and the daily check posts from 05:00 UTC.
`get_seo`/`GET /api/v1/ranks` shows `configured: true`.

## What wrong looks like

- Test says the login is refused: the account password was pasted instead of the API password.
- A `broken` row naming a location or language code: DataForSEO refused that country. The human picks another in the
  site's Ranks settings, or removes the country.
- Rank checks stop: the site's monthly cap is reached, or the DataForSEO balance is empty.
