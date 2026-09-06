# g33kVault for Apple TV

Native tvOS app that shows the g33kVault slideshow on an Apple TV. See
[Apple TV app](../README.md#apple-tv-app) in the main README for what it does and why
it's a native SwiftUI app rather than a web-view wrapper (tvOS has no WebKit at all).
This file covers building, installing, and updating it.

## Requirements

- A Mac with Xcode 15+ installed
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) — the
  actual Xcode project (`g33kVaultTV.xcodeproj`) is generated from `g33kVaultTV/
  project.yml`, not checked into git, same idea as not committing a compiled binary
- An Apple ID signed into Xcode (**Xcode → Settings → Accounts**) — a free account
  works for installing on your own device, it just means the app's signature expires
  after 7 days and needs reinstalling; a paid Apple Developer Program membership
  ($99/year) removes that limit

## Generate the Xcode project

Do this once, and again any time `project.yml` changes:

```bash
cd tvos/g33kVaultTV
xcodegen generate
```

## Install on a real Apple TV

**1. Put the Apple TV in Developer Mode** (required since tvOS 16, same idea as iOS):
on the Apple TV, go to Settings → Privacy and Security → Developer Mode → turn it on.
The Apple TV restarts.

**2. Pair it with Xcode.** Your Mac and the Apple TV need to be on the same Wi-Fi
network. Open Xcode → **Window → Devices and Simulators** — the Apple TV should show
up automatically (Bonjour discovery); select it and click **Pair**. If it doesn't
appear, go to Settings → Remotes and Devices → Remote App and Devices on the Apple TV
to make it discoverable first.

**3. Open the project and choose your signing team:**

```bash
open g33kVaultTV.xcodeproj
```

Select the `g33kVaultTV` target → **Signing & Capabilities** → pick your name/team
from the **Team** dropdown (signing is already set to Automatic in `project.yml`).

> **Team selection doesn't survive `xcodegen generate`** — since the `.xcodeproj` is
> fully regenerated from `project.yml` each time, picking a team in Xcode's UI only
> lasts until the next `xcodegen generate`. To make it stick, add your Team ID to
> `project.yml` under the target's `settings.base`:
> ```yaml
> DEVELOPMENT_TEAM: "YOUR_TEAM_ID"
> ```
> Find your Team ID in Xcode → Settings → Accounts → click your account → shown next
> to your team name, or on [developer.apple.com/account](https://developer.apple.com/account)
> under Membership.

**4. Run it.** Pick your Apple TV from the device dropdown at the top of the Xcode
window (instead of a Simulator), then hit **▶ Run**. Xcode builds, installs, and
launches it on the actual TV. On first launch, enter your g33kVault server's LAN
address (e.g. `192.168.1.42:3000`) on the Settings screen — same address you'd use in
a browser for the host screen or `/admin`.

## Install on the tvOS Simulator (no physical device needed)

Useful for quick iteration. From `tvos/g33kVaultTV`, after `xcodegen generate`:

```bash
# Build for the simulator
xcodebuild -project g33kVaultTV.xcodeproj -scheme g33kVaultTV \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' \
  -configuration Debug build

# Boot a simulator, install, and launch (find the built .app path in the build
# output, or under ~/Library/Developer/Xcode/DerivedData/g33kVaultTV-*/Build/
# Products/Debug-appletvsimulator/g33kVaultTV.app)
xcrun simctl boot "Apple TV 4K (3rd generation)"
xcrun simctl install booted /path/to/g33kVaultTV.app
xcrun simctl launch booted com.g33kvault.tv
```

The Settings screen's text field can't be typed into with a real keyboard in the
Simulator's remote-control input; the easiest way to set a server address for testing
is writing it directly to the simulator's UserDefaults before launching:

```bash
xcrun simctl spawn booted defaults write com.g33kvault.tv g33kvault.serverAddress "localhost:3000"
xcrun simctl launch booted com.g33kvault.tv
```

## Updating an already-installed app

- **Via Xcode**: just hit **▶ Run** again with the Apple TV selected as the
  destination — this rebuilds, reinstalls, and relaunches over the existing app,
  keeping its saved server address.
- **Free Apple ID accounts**: the app's signature expires 7 days after installing.
  Once it does, the app stops launching on the Apple TV (no update needed on your
  end, just re-run from Xcode to re-sign and reinstall it).
- Changed `project.yml`? Re-run `xcodegen generate` before building — Xcode won't
  pick up target/settings changes otherwise. Remember the Team ID caveat above if you
  hadn't baked it into `project.yml`.

## Changing the server address / resetting the app

Press **Menu** on the Siri Remote from anywhere in the slideshow to come back to the
Settings screen and enter a different address — no reinstall needed. Deleting the app
from the Apple TV's Home Screen (press and hold its icon → Delete) clears the saved
address too, if you want a clean slate.
