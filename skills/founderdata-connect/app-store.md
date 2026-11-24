# App Store: the SDK in Xcode and Server Notifications

## Unlocks

App purchases, renewals, refunds and trials in revenue, credited to the install's session and source. Steps `sdk:<site>`
and `apple:<site>`. For Apple's sales and proceeds reports, see `app-store-connect.md` (Pro).

## Cost

Free.

## Needs

- The app's repository on this machine, Xcode 26 or later, iOS 17 or later (`ios/README.md`).
- The bundle id on the site, before the first launch. The server answers 403 to app events and rejects Apple's
  notifications until it is set, and the SDK drops a batch that gets a 403 without retrying.
- An Apple developer account with the role Account Holder, Admin, App Manager or Marketing to set the notification URL
  (<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications>).
  The human signs in with 2FA (STOP).

## Fastest path

### 1. Read the bundle id  [agent]

No window needed. From the repo:

```bash
grep -rhoE 'PRODUCT_BUNDLE_IDENTIFIER = [^;]+' --include=project.pbxproj . | sort -u
```

A value like `$(SOME_VAR)` resolves in a `.xcconfig`. Ask the human when several targets show up (app, widget, tests).
Put the app's id on the site: `app_bundle_id` in `sites.json`, then `node scripts/setup-sites.mjs ORIGIN`.

### 2. Add the package and link it  [agent with agent-desktop]

Apps that already have a `Package.swift` take one line (`install.md`, section D). For an `.xcodeproj`, Xcode's package UI is
the safe route, because a hand-edited `project.pbxproj` breaks easily. Drive it with agent-desktop
(`skills/founderdata-browser/SKILL.md`). The flow below follows the commands in the agent-desktop docs and `--help`. It was
not run against Xcode 26, so snapshot before each click.

```bash
agent-desktop permissions --guide                # STOP once: the human allows Accessibility
agent-desktop launch Xcode --activate
agent-desktop snapshot --app Xcode --surface menubar -i       # find File
agent-desktop click @<id>:eN                                   # File
agent-desktop snapshot --app Xcode --surface menu -i
agent-desktop click @<id>:eM                                   # "Add Package Dependencies..."
agent-desktop wait --text "Search or Enter Package URL" --app Xcode
agent-desktop snapshot --app Xcode -i --compact
agent-desktop type @<id>:eK "https://github.com/founderdata/founderdata"
agent-desktop press return
```

Then set the dependency rule to **Up to Next Major Version** from `1.0.0`, click **Add Package**, and in the next sheet
tick `FounderDataKit` for the app target (not the widget or test targets). Click **Add Package** again. Verify without
looking at the screen: `grep -c FounderDataKit <project>.xcodeproj/project.pbxproj` is at least 1, and
`xcodebuild -resolvePackageDependencies -project <project>.xcodeproj` succeeds. Compile through the repo's usual build
route (on a shared Mac, its build queue), not by hand.

### 3. Wire the code  [agent]

`install.md`, section D: `configure`, `observeTransactions`, `.onOpenURL`, the purchase wrapper. Commit on a branch.

### 4. Point App Store Server Notifications at FounderData  [browser, you]

Renewals that happen while the app is closed reach FounderData only this way (not needed with RevenueCat). Apple signs the
notifications and FounderData verifies them against the Apple root certificate built into the Worker, so **no secret is
involved**.

1. `agent-browser --headed --session founderdata open https://appstoreconnect.apple.com`. **STOP** for Apple ID, password
   and 2FA.
2. Apps, the app, **App Information**, scroll to **General Information, App Store Server Notifications**.
3. **Production Server URL, Set Up URL**, enter `ORIGIN/api/webhooks/apple/SITE_ID`, choose **Version 2**, Save.
4. Sandbox Server URL: leave it empty, or set the same URL. Apple's page says that with no sandbox URL, notifications for
   both environments go to the production URL. FounderData ignores sandbox purchases unless the site's sandbox setting is on.
   Setting only a sandbox URL sends nothing in production.

## Connect command

None. Nothing secret moves. The URL and the bundle id are the connection.

## Verify

- `sdk:<site>`: `done` on the first event, after the human runs the app once on a device or simulator.
- `apple:<site>`: `waiting` once the URL is saved, `done` when the first Apple notification arrives. A TestFlight or sandbox
  purchase sends one, so the human buys the cheapest product in a sandbox account. `get_setup` evidence names it.
  Sandbox purchases never count as revenue.

## What wrong looks like

- No events and the dashboard says the bundle is not set: step 1 was skipped, or the id differs from the app's.
- Notifications refused: Version 1 is selected, or the URL has a typo. Edit it in App Information.
- A purchase has no source: the app did not pass `.appAccountToken(FounderData.appAccountToken)` (`install.md`).
