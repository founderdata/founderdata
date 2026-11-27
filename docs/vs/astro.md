# FounderData vs Astro

Astro is a native Mac app for iOS keyword research and rank tracking. It is the indie favourite for good reasons. It
already knows which keywords your app ranks for, shows Apple Search Ads popularity and a difficulty score, spies on a
competitor's keywords, covers 91 storefronts with no keyword cap and has a fast single-view interface.

FounderData Pro's ASO tab does the core job, ranks per keyword and country with the 10 apps above you, and puts it beside the
revenue and the retention of the same app. It does not match Astro's keyword discovery or its country coverage.

Checked in November 2026. Astro's price and limits come from tryastro.app and its docs, read on 6 November. Appfigures
prices were read on 3 November. They may have changed.

## Side by side

| | Astro | FounderData |
| --- | --- | --- |
| Where it runs | A Mac app, macOS 14 or later. Ranks update only while the app runs | Your Cloudflare account. Hosted ranks run on the cron. The free collector script runs on a machine you pick |
| Price | $9 a month billed yearly at $108, one Mac, 14-day refund instead of a trial | Core is free under MIT. The ASO tab is in FounderData Pro, €99.99 or $99.99 once. Hosted ranks cost DataForSEO's price, an estimated $26 to $52 a month for 720 keyword and country pairs checked daily. Those prices are unverified |
| Keywords and countries | No cap on keywords or apps. 91 of 175 storefronts | 200 keywords, 10 countries and 5 competitors per app, 1,000 keyword and country pairs in all. 50 of the 52 App Store countries FounderData tracks work with hosted ranks |
| Rank history | In the Mac app's database | 90 days shown in the tab. Older snapshots stay in the database |
| Popularity | Apple Search Ads popularity | Apple Ads Platform API search popularity, by week |
| Difficulty | A score to reach the top 10 | Worked out in the browser from the top 10 apps, their rating counts and name matches |
| Keyword discovery | Already knows your keywords, suggestions from other Astro users, competitor keyword extraction | A button lists the keywords your app ranks for in the US store with rank and Apple search volume, and costs DataForSEO's price per call. Search hints for suggestions. No competitor keyword extraction |
| Competitors | Paste a competitor's URL to see every keyword it ranks for | Up to 5 competitors per app, ranked on the same keywords, with title, subtitle and ratings |
| Ratings and reviews | Ratings tracking | Ratings per country, new reviews, and an alert for a new review of 3 stars or fewer. These need the collector script, not hosted ranks |
| Platforms | iOS, iPadOS, Mac, tvOS and watchOS rankings. No Google Play | iPhone App Store search only. No Google Play |
| Translation | Keyword translation through DeepL | None |
| Revenue next to ranks | No | App Store sales, subscriptions, Apple Search Ads spend and ROAS and the funnel of the same app, all in Pro |
| Agents | Local MCP server, 12 tools, beta. No API or CLI | In Pro, MCP with 40 tools, an `aso:write` key for push scripts, an MCP prompt that audits ASO |
| Sharing | One license, one Mac, no web view | The dashboard, a share link, a read API |

Appfigures is the other tool people use here. It has a free plan for 5 apps, Monitor with 100 keywords at $44.99 a month or
$35.99 billed yearly, and Optimize with 500 keywords at $149.99. Its keyword exports also import, since FounderData reads
the `Keyword` and `Country` columns of any CSV with a header.

## What FounderData does not do

- **No keyword database.** Discovery is a list of what your app already ranks for and Apple's search hints. Astro starts
  from millions of keywords.
- **Caps.** 200 keywords and 10 countries per app. Astro has none.
- **Not every country leaves your Mac.** Russia, China and Taiwan stay with the collector. Reviews, ratings and review
  alerts are collector-only, so a Mac that is off means no new reviews. You may still want Appfigures for those.
- **The collector uses endpoints Apple's terms do not allow automated access to.** You decide whether to run it. Hosted
  ranks avoid them through DataForSEO's licensed API.
- **The hosted top 10 has no subtitle or release day,** so difficulty is weaker than a collector run.
- **No overall visibility trend and no ASO tips.** Both are Astro's most requested items too.
- **No translation, no Mac, tvOS or watchOS rankings, no Google Play.**
- **Prices are estimates.** No DataForSEO invoice backs the $26 to $52 yet. Run it beside Astro for one billing month and
  judge the invoice.
- **Setup is a terminal job.** See the [README](../../README.md#install). The setup checklist in Settings tests the
  DataForSEO login and lists any country DataForSEO refuses.

## Moving over

1. In Astro, export a keyword list as CSV.
2. In FounderData's ASO tab, open **Import keywords from a file**. It reads Astro's `Keyword` column and the country in
   `Store Domain`. If the export holds several apps, the tab asks which one. A `Ranking` column is stored as today's rank
   with the source `import`. See [Import keywords](../ASO.md#import-keywords).
3. Not imported, because Astro's numbers would not match FounderData's own: popularity, difficulty, notes, tags and rank
   history. A move through Astro's database file is not supported.
4. Turn on [ranks without your Mac](../ASO.md#ranks-without-your-mac) with your DataForSEO login, or run the
   [collector](../ASO.md#set-it-up).
5. For sales history, import up to a year of Apple's daily Sales report with `scripts/asc-backfill.sh`. See
   [App Store sales](../GUIDE.md#app-store-sales-pro).
