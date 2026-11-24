# Search Console (Pro)

## Unlocks

The SEO tab's clicks, impressions, queries, pages, decay and opportunities, filled by the Worker every hour with no machine
of yours involved. Step ids `google` (deployment) and `google:<site>`. Needs a `pro/` folder.

## Cost

Free. It uses the owner's own Google Cloud project.

## Needs

- A Google account that can read the site's Search Console property.
- A Google Cloud project with the Search Console API on and a Web application OAuth client.
- The Worker's redirect URI: `ORIGIN/api/seo/google/callback` (the SEO tab and `GET /api/setup` show it character for
  character).
- Source for the click path: `docs/SEO.md`, "Connect Google". Google's own console labels change, so snapshot each page.

## The 7-day trap: set the app to In production

Facts, checked against Google's pages on 2026-11-24:

- An OAuth app in **Testing** status with an External user type gets a refresh token that expires in 7 days, unless the
  scopes are only name, email and profile. FounderData's scope is `https://www.googleapis.com/auth/webmasters.readonly`, so
  the 7 days apply: <https://developers.google.com/identity/protocols/oauth2#expiration>,
  <https://support.google.com/cloud/answer/15549945>.
- **In production** has no 7-day rule. A token still dies when the user revokes access, after six months unused, or when
  the account has too many live tokens (same expiry page).
- An unverified app that requests sensitive or restricted scopes shows Google's "Unverified app" warning and is limited to
  100 new users for the life of the project (<https://support.google.com/cloud/answer/7454865>,
  <https://support.google.com/cloud/answer/13463817>). One owner is one user. Whether `webmasters.readonly` counts as
  sensitive is not stated in the pages that could be read: the consent screen shows the class when the scope is added.
- Not confirmed in Google's help pages: that the owner can click through the unverified screen for their own project. It is
  the usual behavior. If Google blocks it, use `scripts/gsc-sync.mjs` with a service account (`docs/SEO.md`, "Sync Search
  Console"), which needs no OAuth app in production.

So: publish to In production **before** the human clicks Connect Google, and tell them to expect one unverified-app screen
(Advanced, then continue). A refused refresh token later (`invalid_grant`) turns the step `broken`: the human clicks
Connect Google again.

## Fastest path  [browser, you]

Google can refuse a sign-in from an automated browser. Open the console headed, let the human sign in, and fall back to
telling them each click if Google blocks the window.

1. `agent-browser --headed --session founderdata open https://console.cloud.google.com`. **STOP** for sign-in and 2FA.
2. Create or pick a project (name it `FounderData`). APIs and services, Library, enable **Google Search Console API**.
3. **Google Auth platform** (the OAuth consent screen): user type **External**, app name `FounderData`, the human's email.
   Under Data access add the scope `https://www.googleapis.com/auth/webmasters.readonly`. Under **Audience**, set the
   publishing status to **In production** (Publish app). This is the step that stops the 7-day expiry.
4. Clients, **Create client**, type **Web application**, authorized redirect URI `ORIGIN/api/seo/google/callback`. Create.
   The client secret appears in the dialog. **STOP**: the human copies the client ID and secret.
5. `npm run connect -- google-search-console` opens the paste page for `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. If the SEO tab still shows the setup steps afterwards, run `npm run setup` once.
6. **STOP**: in the SEO tab the human clicks **Connect Google**, approves read-only access (past the unverified screen),
   and picks the Search Console property for each site (`sc-domain:acme.example` or `https://acme.example/`). Only an
   owner can do this, and an agent key cannot.

## Connect command

```bash
npm run connect -- google-search-console
```

## Verify

`google` is `done` once connected. `google:<site>` is `waiting` until the first sync day arrives, then `done`: the cron
adds about 10 days a run, so the first days show within the hour and the 16-month backfill takes about two days.
`get_seo` answers.

## What wrong looks like

- Step `broken` with `invalid_grant`: the token expired (Testing status, revoked, six months idle). Check the publishing
  status first, then the human clicks **Connect Google** again. Stored numbers stay.
- Google says `redirect_uri_mismatch`: the client's URI differs from `ORIGIN/api/seo/google/callback`, including `https`.
- A property Google refuses (403 or 404): the human picks another, or adds this Google account as a user of the property.
- Changing a site's property deletes its stored `gsc_*` data (the numbers belong to the old property).
