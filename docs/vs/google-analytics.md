# FounderData vs Google Analytics

Google Analytics 4 is free and runs on Google's servers. Keep it if you buy Google Ads, track an Android app through
Firebase, or want your raw events in BigQuery. It knows little about your payments. A sale counts only when your own
code sends a purchase event.

FounderData is a Google Analytics alternative for founders who sell something and want each payment tied to the visit
that brought it. It runs on your own Cloudflare account, sets no cookies unless you turn them on, and your AI agent can
read it with one key.

Checked on 23 November 2026, from Google's help pages and developer docs. Google changes them, so check the
[sources](#sources) before you decide.

## Side by side

| | Google Analytics 4 | FounderData |
| --- | --- | --- |
| Price | Free. Analytics 360 is listed with no public price | Core is free under MIT. FounderData Pro, €29.99 or $29.99 once, adds subscriptions, iOS app reports, SEO and AI visibility. Cloudflare's free plan covers about 3,100 web visits a day, and Workers Paid is $5 a month past that |
| Where the data lives | On Google's servers, under Google's terms | In a D1 database in your own Cloudflare account. Created with `--jurisdiction eu`, it stays in the EU |
| Cookies | Sets `_ga` and `_ga_<container-id>`, each for 2 years by default. With consent mode, a visitor who declines gets cookieless pings in Advanced mode, which Google uses to model the gap, or nothing at all in Basic mode | None by default. The visitor id is a hash of IP and user agent with a salt that changes every day, and the IP is not stored. Cookies only when your site turns them on after consent |
| How long data stays | Event data in explorations and funnel reports: 2 or 14 months on the free version, up to 50 months on 360. Age, gender and interest data: always 2 months. Standard reports are not affected | You set it. Visits and events go after 24 months by default, payments stay for your books |
| Sampling and thresholds | Explorations can be sampled above 10 million events per query on the free version. Thresholds hide rows that include demographics, and search queries with too few users. You cannot change them | Neither. Each report is a query over the rows in your own database |
| Revenue | Your site sends a `purchase` event with a transaction id, value and items, and a `refund` event for refunds. No connection to Stripe or another payment provider. The Measurement Protocol takes server-side events, but Google says it only adds to tagging and does not replace it | Server-side webhooks from Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, App Store and RevenueCat. Each payment is credited to the buyer's last visit from a real source, with renewals and refunds. MRR, churn and cohorts are in Pro |
| Script size | `gtag.js` was 158 KB gzipped and 447 KB unpacked, measured on 23 November 2026 with a placeholder measurement id | About 4 KB gzipped |
| AI agents | Google's MCP server runs on your machine in Python 3.10 or later. It needs a Google Cloud project with the Admin and Data APIs turned on, plus Application Default Credentials. It reads reports and is read-only by default | An MCP server at `/mcp` on your own Worker. Claude Code or Cursor connects with one scoped key. 9 tools in core, 38 in Pro. Agents can also log a change and get a verdict on it a week later |
| Apps | iOS, Android, Flutter and Unity apps through the Firebase SDK | A Swift SDK for iOS 17 and later, with StoreKit 2 and RevenueCat purchases. No Android |
| Google Ads | Links to Google Ads. Ads then imports key events and remarketing audiences from Analytics, and Analytics shows Ads cost and clicks | Reads Google Ads click ids, so an ad visit counts as Paid and not as organic search. Pro takes Google Ads spend from a script in your Ads account. Nothing goes back to Google Ads |
| Search Console | Free link to Search Console | In Pro, with 16 months of queries next to visits and revenue per page |
| Raw data | Free BigQuery export, limited to 1 million events a day on the free version. BigQuery storage and queries past the sandbox are billed by Google Cloud | CSV export of every panel, visit, event, payment and subscription, and a read API. The D1 database is yours to query with SQL |

## What FounderData does not do

- **No hosted version.** There is no signup page. You deploy it to your own Cloudflare account.
- **No Android SDK.** Apps are iOS only.
- **No GA4 import.** Your Google Analytics history stays in Google Analytics. The [import API](../IMPORT.md#api) takes
  daily totals from a script, but no GA4 script ships.
- **Nothing goes back to Google Ads.** No conversions and no audiences. Meta is the only ad
  network FounderData sends conversions to, in Pro.
- **No free-form report builder like Explorations.** Pro's `query` tool answers any metric by up to 2 dimensions, and Pro
  has custom dashboards.
- **Setup is a terminal job.** See the [README](../../README.md#install).

## Moving over

1. Deploy FounderData with `npm run setup` ([README](../../README.md#quick-start)). It takes Node 20 and a free
   Cloudflare account.
2. Add the script tag next to your Google Analytics tag and run both for a few weeks. Expect different numbers. Where
   you ask for cookie consent, Google Analytics gets nothing from visitors who decline in Basic mode and models them in
   Advanced mode. FounderData needs no cookies, so it counts those visits.
3. Connect your payment provider, and use [Import Stripe history](../GUIDE.md#import-stripe-history) for past
   payments.
4. Export the Google Analytics reports you want to keep. FounderData cannot read them.
5. Remove the Google Analytics tag. Its cookies go with it.
6. In Pro, connect [Search Console](../SEO.md#connect-google) for the search data you used to read in Google Analytics.

## Sources

Google's pages, read on 23 November 2026:

- [Google Analytics](https://marketingplatform.google.com/about/analytics/): free, and 360 without a price
- [Data retention](https://support.google.com/analytics/answer/7667196)
- [About data sampling](https://support.google.com/analytics/answer/13331292)
- [Data thresholds](https://support.google.com/analytics/answer/9383630)
- [Consent mode](https://support.google.com/analytics/answer/9976101)
- [Cookie usage on websites](https://support.google.com/analytics/answer/11397207)
- [BigQuery export](https://support.google.com/analytics/answer/9358801)
- [Measure ecommerce](https://developers.google.com/analytics/devguides/collection/ga4/ecommerce)
- [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
- [Google Analytics MCP server](https://developers.google.com/analytics/devguides/MCP)
- [Connect Google Ads](https://support.google.com/analytics/answer/9379420)
- [Connect Search Console](https://support.google.com/analytics/answer/10737381)
- [Firebase Analytics, supported platforms](https://firebase.google.com/docs/analytics/get-started)
