# Changelog

Every release of FounderData, newest first. Core and FounderData Pro share version numbers, and each Pro release
contains the core release of the same version. The Swift package lists its own changes in
[ios/CHANGELOG.md](ios/CHANGELOG.md).

This file is made from `release.json` by `npm run release` (docs/RELEASING.md). Edit `release.json`, not this file.

## 1.5.1 (2026-11-26)

- Your coding agent can set FounderData up from one prompt. It deploys, adds your sites, installs the tracker, connects your payment provider and connects itself over MCP. docs/AGENT-SETUP.md has the prompt.
- Home shows a setup card while a required step is open, with the next step and a prompt for your agent. A new install opens Get started on its first visit.
- A payment provider whose secret you saved reads Waiting until its first payment arrives, instead of Connected.
- npm run doctor checks your install without changing anything and names the next step. npm run connect opens a page on your own machine where you paste a provider's secret, so your agent never sees it.
- Agents read the setup steps with the get_setup MCP tool or GET /api/v1/setup.

FounderData Pro:

- Custom dashboards have a goal widget. It adds up this month across your sites in one currency against a monthly target, as revenue or as profit after Apple's share and each provider's fee.
- Custom dashboards have a search widget with one site's Search Console clicks, impressions, click-through rate and average position side by side.
- The Mail page has Inbox, Archive and Trash folders and an Unread filter. You can undo Archive and Trash for a few seconds, and restore a thread, delete it for good or empty the trash.
- In the iPhone app, Mail changes many threads in one go with one Undo, and Delete for good and Empty Trash finish at once.
- A thread you delete for good takes no more replies and puts no card in Today.

## 1.5.0 (2026-11-22)

- A bar on Home's revenue chart opens that day's revenue by site and by source, with the payments behind it.
- Live keeps every visit of its window in a scrolling list, instead of the newest 12.
- Send a "How did you hear about us?" answer from your own signup form with founderdata('answer', ...), and the Channel card on Overview has a Heard about tab.
- Settings > Updates lists every release between your version and the newest one, with what changed in core and in Pro.

FounderData Pro:

- Experiments and feature flags on your website, judged on revenue per visitor and a goal you pick. Experiments from your iOS app sit in the same list, and a chart note marks when each one starts and stops.
- Needs you on the web and Today in the iPhone app: mail that waits on your answer with your agent's draft, questions from your plan's agent, and what is broken now.
- Errors: uncaught JavaScript errors grouped into issues and sorted by the paying customers they hit, with an alert for new errors and for resolved ones that come back.
- Click maps drawn over your live page, scroll depth for every page, and Paths that follow visits up to 3 pages.
- A survey card asks "How did you hear about us?" and "Why are you canceling?", and cancel reasons also arrive from Stripe, Polar, the App Store and Google Play.
- People has a Retention view: weekly lifecycle bars and retention by the week people were first seen.
- Recordings skip idle stretches over 10 seconds, get a short summary, and filter by error, experiment version, channel, paying customer and funnel step.
- The iPhone app has a Mail tab with Sent, Archive and Trash, filters, search, and replies with files.
- The Mail inbox lists threads with a received message. A thread you started stays in Sent until someone answers.
- New websites start with Record visits and Remember visitors on. Sites you added before keep their settings.
- A key without read:revenue sees no money and does not learn who paid, in experiments, errors, recordings, people and paths.

## 1.4.0 (2026-11-20)

- The dashboard refuses cookie writes from other origins and sends frame and referrer headers.
- Erasing a user by id also erases their RevenueCat ids.
- The guide has a setup table for every integration: what it turns on and which secrets it needs.

FounderData Pro:

- Custom dashboards that your AI agent builds over MCP.
- AI visibility asks a prompt weekly instead of daily once its answers stop changing.

## 1.3.0 (2026-11-20)

No changes to core.

FounderData Pro:

- Mail problems alerts: a domain that fails its daily check, sends that fail, and received mail that FounderData could not store. Every alert channel gets them, and you can switch them off per channel on the Notifications page.

## 1.2.1 (2026-11-20)

No changes to core.

FounderData Pro:

- Pages such as /dashboard or /account can stay out of recordings, and the tracker sends no clicks or errors from those pages.

## 1.2.0 (2026-11-20)

- identify() takes traits, and a visitor profile shows every device with the same user id or email.
- Mail hooks and mail scopes for API keys, used by FounderData Pro's mail.

FounderData Pro:

- People: each person's visits, payments and a one-line story.
- Recordings of website visits, with typing hidden. They stay off until you switch them on in Settings, and can wait for consent.

## 1.1.0 (2026-11-19)

- Polar webhooks accept the signatures of endpoints made since September 2026, as well as the old key.
- Pro sections show what each report does and the current Pro price.

FounderData Pro:

- The license summary says a Pro license is personal to the buyer.

## 1.0.0 (2026-11-18)

- First public release: website and iOS app analytics with revenue attribution, on Cloudflare Workers and D1.

FounderData Pro:

- First release of FounderData Pro.
