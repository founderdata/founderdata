# FounderData vs RevenueCat and ChartMogul

RevenueCat is the subscription layer for many iOS apps, and its Charts are included with it. They cover MRR and its
movement, trial conversion, realized LTV, a cohort explorer, a prediction explorer and filters by Apple Search Ads
campaign and keyword, plus a free iPhone app with a push per transaction. ChartMogul is the SaaS metrics tool, with
net revenue retention, churn, segments, a 90-day ARR projection and the best import path for history.

FounderData reads the same events and shows subscriptions beside the visits, sources and ads that brought each buyer.
It does not replace the SDK or billing logic of RevenueCat, and it covers less than ChartMogul's analysis.

Checked in November 2026. Prices were read on 3 November and features on 6 November, from the vendors' own pages. They may
have changed.

## Side by side

| | RevenueCat | ChartMogul | FounderData |
| --- | --- | --- | --- |
| What it is | SDK, entitlements and charts for in-app subscriptions | Subscription analytics for Stripe and other billing sources | Analytics with attribution. Reads Stripe, App Store, RevenueCat and more |
| Price | Free up to $2,500 of monthly tracked revenue, then 1% of tracked revenue. Charts included | Free up to $120,000 ARR. Starter $69 to $849 a month, $57 to $707 billed yearly. Pro $119 to $1,439. Priced by ARR | Core is free under MIT. Subscription metrics, cohorts and the iPhone app are in FounderData Pro, €99.99 or $99.99 once |
| MRR and movement | Yes | Yes | In Pro: new, churned, trials, trial to paid, LTV, refunds and failed payments |
| Split by source | Apple Search Ads campaign, ad group, keyword, country, offering | Segments by plan or MRR band | Channel, referrer, campaign, product and provider. Web and App Store in one table. Apple Search Ads spend and ROAS per campaign and keyword |
| Cohorts | Cohort Explorer, windows from 7 days to unbounded | Logo retention by cohort | In Pro, a monthly grid by signup month, customers or revenue kept, split by plan, provider, channel or referrer, with a click through to the subscriptions |
| Prediction | Predicted LTV per cohort after 7 to 14 days | A 90-day ARR projection | None |
| Retention metrics | Charts | Net revenue retention, CAC payback | In Pro, churn and cohort retention. No net revenue retention |
| Alerts | One Slack message per event | Slack real-time or a digest at 09:00 UTC | Slack, Discord, Telegram, webhook or email for each payment, refund, failed renewal and cancellation. Pro adds the MRR lost and an optional daily message with MRR and change, new and churned subscriptions and the last Stripe check |
| Phone | Free official iPhone app with a push per transaction | Not found in our research | In Pro, an iPhone app you build with your own Apple team, with widgets and a push per payment |
| API and export | Charts API at 25 requests a minute, daily exports to S3, GCS, Azure or R2, CSV per chart | Import API, CSV | Read API, CSV export of every panel and subscription |
| Agents | Hosted MCP with OAuth that reads and writes products and offerings | Experimental MCP with OAuth | MCP with a pasted key, 10 tools in core and 40 in Pro. Read mostly, with notes and the Pro research log as the writes |

## What FounderData does not do

- **No RevenueCat key-based check.** RevenueCat's chart API shape is not in the docs FounderData was built from. You
  export the MRR chart as CSV and paste it. FounderData's own ChartMogul check uses ChartMogul's API with your key.
- **No predicted LTV, no ad payback prediction, no ARR projection, no net revenue retention, no CAC payback, no CRM.**
- **No weekly cohorts.** Cohorts are by signup month.
- **ChartMogul's revised old months are lost.** ChartMogul corrects past MRR, for example when an invoice is paid late.
  The activities FounderData reads today can differ from what your dashboard showed last year. Rebuild board numbers
  before you rely on them.
- **Month 0 counts subscriptions, not customers.** A customer with two subscriptions counts twice. ChartMogul's cohorts
  count customers, so cohort sizes will differ.
- **Payments and revenue history do not come across** in either subscription import. Money received stays from Stripe or
  App Store sales.
- **Billing math differs a little.** RevenueCat counts a weekly price as 4 a month. FounderData uses 52 divided by 12.
  FounderData counts gross, before tax and commission.
- **It is not a billing system.** RevenueCat's SDK, paywalls and entitlements stay where they are. FounderData receives
  its webhook.
- **Teammates are owner or viewer for every site.** No single sign-on.

## Moving over

Keep RevenueCat for billing. What moves is the history, so the MRR chart and the cohort grid start at your first paying
customer and not on the day you connect.

1. **RevenueCat history.** Set up a Scheduled Data Export of the Transactions feed as CSV in RevenueCat. Scheduled exports
   depend on your plan, so check yours. RevenueCat's docs do not say how far back the first delivery reaches, so compare
   the oldest month afterwards. Then choose the file in Settings, Import subscription history, From RevenueCat. See
   [Import from RevenueCat](../GUIDE.md#import-from-revenuecat-pro).
2. **ChartMogul history.** Create a read-only API key, then use From ChartMogul. It reads every price change and
   cancellation, and **Check months** compares each month-end MRR with ChartMogul's own. See
   [Import from ChartMogul](../GUIDE.md#import-from-chartmogul-pro).
3. **Stripe history.** A read-only key imports 3 to 36 months of charges. The subscription is rebuilt from payments, so a
   price change or a pause can be wrong. The Stripe check keeps a dated history, so you can watch the gap close. See [Import Stripe history](../GUIDE.md#import-stripe-history).
4. **App Store sales.** Add an App Store Connect key with the Sales and Reports role. `scripts/asc-backfill.sh` imports up
   to a year. See [App Store sales](../GUIDE.md#app-store-sales-pro).
5. **Going forward.** Add the RevenueCat webhook in Settings, Payments, and set the visitor id as a subscriber attribute.
   See [ios/README.md](../../ios/README.md#using-revenuecat).
6. **Check the gap.** Open **Who moved** on the biggest months in the check table. Run both tools side by side until the
   month-ends agree.
