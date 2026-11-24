# Apple Search Ads (Pro)

## Unlocks

Names for campaigns, ad groups and keywords, and Apple's daily spend, taps, installs and impressions, so the Apple Search Ads
section shows cost per paid customer and ROAS per campaign and keyword. Step id `apple-search-ads`. Needs a `pro/` folder.
Optional, and only for apps that run Apple Ads.

## Cost

Free. The key is read-only.

## Needs

- An Apple Ads account (Advanced) and an account admin to invite the API user. Source: `docs/GUIDE.md`, "Apple Search
  Ads", which follows Apple's page
  <https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api>.
- A second Apple Account for the API user: not the owner's own.
- OpenSSL on this machine.
- The app's App Store id on the site (General in the site's settings, or the App Store sales import finds it from the bundle
  id). Without it the app's spend shows on no site.

## Fastest path  [agent, browser, you]

1. [agent] Make the key pair. The private key stays in a file you never open:

   ```bash
   umask 077; D=$(mktemp -d)
   openssl ecparam -genkey -name prime256v1 -noout -out "$D/private-key.pem"
   openssl ec -in "$D/private-key.pem" -pubout -out "$D/public-key.pem"
   ```

   Reading `public-key.pem` is fine: it is public. Never print `private-key.pem`.
2. [browser, you] `agent-browser --headed --session founderdata open https://ads.apple.com`. **STOP** for sign-in as an
   account admin. Account Settings, User Management: invite a user with the **API Read Only** role to the second Apple Account.
   **STOP**: the human accepts the invite as that user and signs in as them.
3. Account Settings, **API**: paste the whole of `public-key.pem` and save. Apple then shows `clientId`, `teamId` and `keyId`
   (identifiers, not secrets; the first two start `SEARCHADS.`).
4. Store them: `npm run connect -- apple-search-ads --file "$D/private-key.pem" --delete-file` for `ASA_PRIVATE_KEY`
   (the file route keeps its line breaks), and the paste page for `ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID` and the
   optional `ASA_AD_ACCOUNT_ID`. Then `rm "$D/public-key.pem"; rmdir "$D"`.

## Connect command

```bash
npm run connect -- apple-search-ads --file <private-key.pem> --delete-file
```

## Verify

`apple-search-ads`: `waiting` until the 03:17 UTC cron imports, `done` after. For the past, the human clicks **Import the
last 90 days** in the Apple Search Ads section (15 days a call). `get_apple_search_ads` with `view: "campaigns"` answers.

## What wrong looks like

- The row is `broken` with Apple's `invalid_client`: the key was refused. The human makes a new API user key in Apple Ads,
  Settings, API.
- Also `broken` when the last import is over 36 hours old.
- A campaign's spend shows on no site: the promoted app's App Store id is missing from the site. Settings, Payments, App
  Store lists each promoted app that no site has.
