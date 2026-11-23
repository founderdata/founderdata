# FounderData compared with other tools

One page per tool you might be using now. Each page says what the other tool does well, puts the numbers side by side,
lists what FounderData does not do, and links the import path if you move.

| If you use | Read |
| --- | --- |
| DataFast | [FounderData vs DataFast](datafast.md) |
| Google Analytics 4 | [FounderData vs Google Analytics](google-analytics.md) |
| Plausible, and a short note on Fathom and Umami | [FounderData vs Plausible](plausible.md) |
| Umami | [FounderData vs Umami](umami.md) |
| PostHog for experiments, flags, replay, heatmaps, errors or surveys | [FounderData vs PostHog](posthog.md) |
| OpenSEO | [FounderData vs OpenSEO](openseo.md) |
| Astro or Appfigures for App Store keywords | [FounderData vs Astro](astro.md) |
| RevenueCat charts or ChartMogul | [FounderData vs RevenueCat and ChartMogul](revenuecat-chartmogul.md) |
| Peec or Profound for AI visibility | [FounderData vs Peec and Profound](peec-profound.md) |

## What FounderData is

Open-source analytics you host yourself on Cloudflare Workers and D1. Core is free under MIT. It joins web and iOS
visits and payments in one database, and a 9-tool MCP server lets your AI agent read them with one key. FounderData Pro, €99.99 or $99.99 once,
adds subscription metrics, Search Console, rank checks, App Store ranks, AI answers and 39 MCP tools
([PRO.md](../PRO.md)). The pages below say which features need Pro. See the [README](../../README.md).

## How to read these pages

- Competitor prices, limits and features were checked in November 2026, from each vendor's own pages where we could read
  them. Vendors change plans often, so check the vendor's page before you decide. A line marked unverified came from one
  secondary source or could not be opened.
- FounderData numbers come from this repository's docs and code. Prices of third-party APIs that FounderData calls, such
  as DataForSEO, are estimates until your own invoice says otherwise.
- Every page has a section called "What FounderData does not do". The pages are not neutral marketing, but they try to
  be fair about what you give up.

## Gaps that apply to every page

These are not built, and no comparison here pretends otherwise.

- **No crawler.** The Page audit reads a file your own crawler pushes. See [SEO.md](../SEO.md#page-audit).
- **No RevenueCat key-based check.** The RevenueCat history check compares against a chart CSV you paste. ChartMogul has a
  key-based check.
- **No verified bot IPs and no crawler by citation by revenue table.** AI crawler hits and AI citations are listed
  separately. See [AI-VISIBILITY.md](../AI-VISIBILITY.md#ai-crawler-hits).
- **A large MCP tool set in Pro.** A Pro server exposes 39 tools, and a client loads all of their descriptions before it
  reads a number. Core has 9. See [MCP.md](../MCP.md).
- **Terminal setup.** You deploy with Node and Wrangler, and several integrations need a secret you set yourself. The
  [setup checklist](../GUIDE.md#setup-checklist) tests each one live.
