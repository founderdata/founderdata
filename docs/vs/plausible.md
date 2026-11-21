# FounderData vs Plausible

Plausible is a privacy-friendly web analytics tool, open source under AGPL, with a hosted Cloud and a one-page dashboard.
Its users like how little there is to learn, the email reports that need no login, the free Search Console link and the
GA4 import. It is a traffic tool first. Revenue is an add-on.

FounderData is for founders who want the same light dashboard plus payments, subscriptions, iOS apps and an agent
interface in one place.

Checked in November 2026. Plausible's prices come from its pricing page code, read on 3 November, and its features from
its docs, read on 6 November. They may have changed.

## Side by side

| | Plausible | FounderData |
| --- | --- | --- |
| Hosting and license | Hosted Cloud, or self-hosted Community Edition under AGPL | Your own Cloudflare account, MIT |
| Price, hosted | Starter, 1 site, $9 a month for 10,000 pageviews and events, $19 for 100,000, $29 for 200,000, $49 for 500,000, $69 for 1 million. Growth, 3 sites and 3 members, $14, $29, $44, $74 and $104 at the same volumes. Business, 10 sites and 10 members, $19, $39, $59, $99 and $139. Yearly is 10 times monthly. 30-day trial | Core is free under MIT. FounderData Pro, €29.99 or $29.99 once, adds subscriptions, iOS app reports, SEO and AI visibility. Cloudflare's free plan covers about 3,100 web visits a day |
| Self-hosting | Community Edition needs ClickHouse. It lacks funnels, user journeys, revenue goals, SSO and the Sites API, and ships twice a year | One Worker and one D1 database, for core and Pro alike. No Docker image |
| Revenue | Revenue goals on Business only. Sent from the browser, credited to the visit where the payment happens. Its docs advise against sending renewals or refunds from webhooks | Server-side webhooks from Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, App Store and RevenueCat. Credited to the buyer's last visit from a real source, with renewals and refunds. MRR is in Pro |
| Funnels | Business only | Included |
| Email reports | Weekly and monthly, unlimited recipients, Slack reports, traffic spike emails | A Monday report and quiet-site alerts, plus in Pro a daily numbers message (MRR and change, new and churned subscriptions, revenue, visitors, Stripe check) and threshold alerts, to Slack, Discord, Telegram, a webhook or email |
| Search Console | Free integration | In Pro, Connect Google with your own Google Cloud client, or a sync script. 16 months of queries |
| Import in | Google Analytics 4 through its API, and CSV. GA4 revenue is not imported | A Plausible export ZIP. Other tools' files may work, and only Plausible's is tested |
| Export out | A ZIP of CSVs, each capped at the top 300 rows, or a full-site export of daily CSVs | CSV export of every panel, visit, event, payment and subscription |
| API | Stats API v2, 600 requests an hour on Business | A read API with scoped keys, 120 new answers a minute per key |
| Agents | No official MCP server. A community one exists, with no support from Plausible | MCP with scoped keys, 9 tools in core. Pro has 39 tools and eleven workflows |
| iOS apps | Not covered | Swift SDK, StoreKit 2 and RevenueCat in core. Onboarding and paywall funnels, retention, Apple Search Ads and ASO in Pro |
| AI referrals | Shows traffic from ChatGPT, Perplexity and Claude | The same, with the customers and revenue that followed. Pro adds an AI visibility runner |

## What FounderData does not do

- **No hosted version.** There is no signup page. You deploy it.
- **No Docker or Postgres option.** It runs on Cloudflare Workers and D1 only.
- **No GA4 import.** Only a Plausible-format export or a DataFast read comes in.
- **No single sign-on and no per-site permissions.** A teammate is an owner or a viewer for every site.
- **No ready-made Looker Studio connector, embeds or white label.** There is a read API and a share link.
- **Setup is a terminal job.** See the [README](../../README.md#install).

## Moving over

1. In Plausible, open the site's settings, then Imports and exports, then Export data. The ZIP arrives by email.
2. In FounderData, open Settings, Import history, and choose the ZIP. The page reads it in your browser and sends daily
   totals. See [Import web history](../IMPORT.md). A year of history is about 4,400 database rows.
3. Imported days show only before FounderData's first own visit, so nothing is counted twice. Imported days have no
   revenue, because there were no visits to link a payment to.
4. Connect your payment provider for new revenue, and use [Import Stripe history](../GUIDE.md#import-stripe-history) for
   past payments.
5. Connect [Search Console](../SEO.md#connect-google).

## A note on Fathom, Umami and PostHog

We did not write pages for these. What we found, from their own docs and changelogs in November 2026:

- **Fathom** keeps EU visitors on EU servers by default, added an AI assistant and an AI tab in October 2026, and
  imports GA4. It has no payment provider connection, only event values.
- **Umami** is MIT and has added session replay, heatmaps, Web Vitals, annotations, revenue reports and a read-only MCP
  server during 2026. FounderData Pro records visits and draws click maps over your real page, both off until you
  turn them on.
- **PostHog** is the tool people keep for replay, feature flags and experiments. Its revenue analytics was in beta, and
  it reads Stripe through its data warehouse. FounderData Pro has recordings, error issues, web retention, two fixed
  surveys, and web experiments and flags judged on revenue per visitor. It has no survey builder, no server-side flags
  for your backend or app, and no source maps for errors. If you need those, keep PostHog and use FounderData for
  revenue and sources.

Only a Plausible-format export imports into FounderData today.
