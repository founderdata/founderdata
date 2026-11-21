# Changelog

Every release of FounderData, newest first. Core and FounderData Pro share version numbers, and each Pro release
contains the core release of the same version. The Swift package lists its own changes in
[ios/CHANGELOG.md](ios/CHANGELOG.md).

This file is made from `release.json` by `npm run release` (docs/RELEASING.md). Edit `release.json`, not this file.

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
