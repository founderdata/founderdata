# App Store Connect sales (Pro)

## Unlocks

Downloads, re-downloads, in-app purchases, proceeds per currency and Apple's cut, for every app, including apps that do not
run the SDK. Step id `asc-sales`. Needs a `pro/` folder: in core the step is `locked`.

## Cost

Free. Apple charges nothing for the Sales and Trends API.

## Needs

- A team API key made by an Account Holder or Admin, with the **Sales and Reports** role only ("Apple has no plain Sales
  role for API keys"). The Worker can then read sales reports and nothing else (`docs/GUIDE.md`, "App Store sales").
- Four values: the `.p8` file, the Key ID, the Issuer ID and the vendor number.
- The apps' bundle ids set on their sites.
- Apple's page on creating keys: <https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api>
  (not fetched here, so the labels below come from `docs/GUIDE.md`).

## Fastest path  [browser, you]

Apple allows **one download** of the `.p8`. Losing it means a new key. The agent never opens the file.

1. `agent-browser --headed --session founderdata open https://appstoreconnect.apple.com/access/integrations/api`. **STOP**
   for sign-in and 2FA.
2. Users and Access, **Integrations**, **Team Keys**. The page shows the **Issuer ID** at the top. Create a key (the plus
   button), name it `FounderData sales`, role **Sales and Reports**. The plan must say this role before you click. Never
   pick a broader one.
3. The **Key ID** is in the key's table row. The human types the Key ID and Issuer ID into the paste page.
4. **Download** the `.p8`. Start the watcher first, so the file never sits in Downloads unguarded:

   ```bash
   npm run connect -- app-store-connect --watch-downloads
   ```

   It waits for `AuthKey_*.p8` in the Downloads folder, stores the key as `ASC_KEY_P8` with its line breaks (a bare
   `secret put` breaks a multi-line value), and deletes the file. **STOP**: the human clicks Download. Then the paste page
   asks for the Key ID, Issuer ID and vendor number.
5. The vendor number: Sales and Trends, Reports, the number next to the user's name. The human reads it from there.

## Connect command

```bash
npm run connect -- app-store-connect --watch-downloads
```

It stores `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_VENDOR_NUMBER`. A `.p8` already on disk: use
`--file <path> --delete-file` instead.

## Verify

`asc-sales`: `waiting` until the 10:30 UTC cron imports a day, then `done`. Pull the past with
`scripts/asc-backfill.sh ORIGIN` (the last 365 days; it reads the saved password from a file and never prints it). The App
Store tab fills. `get_app_store_sales` answers.

## What wrong looks like

- `broken` with Apple's `401`: the Key ID, Issuer ID or role is wrong, or the key was revoked.
- All four set and a day shows no data: Apple's 404 "no sales" is stored as a zero day. That is real.
- Rows "unmatched": the site's bundle id is missing or differs. Set it.
- The `.p8` missed the watcher: the human downloaded it before the watcher ran. Apple will not offer it twice. Make a new
  key, and the human revokes the old one in Apple (you never delete or change a key's permissions).
