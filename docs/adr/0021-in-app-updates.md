# 0021: In-app updates with Sparkle

- Status: accepted
- Date: 2026-11-14 (accepted 2026-11-15, after the spike below)

## Context

The only way to install the macOS client is `macos/scripts/install.sh`: clone the repo,
have Xcode, build. Nobody without a checkout can run Achtung, and even on the author's
own MacBook the installed build falls behind main for days. A "Check for Updates…"
command that fetches the latest build of main, as Ghostty's "tip" channel does, fixes
both.

Constraints:

- The app is signed ad hoc (`CODE_SIGN_IDENTITY: "-"`), not sandboxed, without hardened
  runtime. There is no Apple Developer ID.
- GitHub's hosted `xcode-27` runner builds the app (ADR 0004). A self-hosted runner was
  considered and rejected: on a public repository any fork PR could run code on it.
- `install.sh` sets the build number (`CFBundleVersion`) to the commit count of `HEAD`
  (`git rev-list --count HEAD`), and the version (`CFBundleShortVersionString`) to the
  short commit hash, with `-dirty` for uncommitted changes. On `main` the count only
  grows.
- The achtunk8s.io zone and the repository's settings are managed in `infra/` (ADR 0020).
  It has no R2 resources yet; the state bucket was created by hand.

## Decision

- **Sparkle 2**, as a Swift package, pinned to an exact version. It is the standard
  updater for apps outside the Mac App Store. It downloads, verifies, replaces the app and
  relaunches it. We don't write our own.
- **Updates are verified with Sparkle's EdDSA signature, and with nothing else.** The
  public key is in `Info.plist` (`SUPublicEDKey`, from `ACHTUNG_UPDATE_PUBLIC_KEY` in
  `macos/project.yml`); the private key is the secret `SPARKLE_ED_PRIVATE_KEY` of the
  GitHub environment `release` and a copy in the author's password manager. The appcast is
  signed too (`SURequireSignedFeed`), so a compromised bucket can't point the app at a
  foreign build, and the archive is verified before anything is unpacked
  (`SUVerifyUpdateBeforeExtraction`; Sparkle refuses to start with a required signed feed
  and without it). Sparkle's code-signing check is only a fallback for a failed EdDSA
  check and needs a Team ID, so with ad-hoc signing it does nothing: two ad-hoc builds
  never satisfy each other's designated requirement. Whoever has the private key can run
  code in every installed copy. That is why the key never shares a machine with a build
  (below), and why it is generated at a desktop session into the login Keychain, not on a
  build machine or over SSH (`generate_keys` can't reach the Keychain over SSH anyway).
- **A build without the public key has no updates.** The updater doesn't start, and
  "Check for Updates…" and Settings say so. The same holds for a Debug build, a build
  with build number 0 (Xcode, `run.sh`, demo mode, `check.sh`), and an app that macOS
  runs translocated (below). `UpdaterAvailability` in AchtungDomain decides, once at
  launch.
- **One channel, "tip"**: every push to `main` that touches the client and passes the
  client check is published. A "stable" channel from tags can follow when there are
  releases; Sparkle's channels (`sparkle:channel`) allow that in the same appcast.
- **The feed lives on our own domain**: `https://updates.achtunk8s.io/tip/appcast.xml`,
  an R2 bucket with a custom domain, both added to `infra/`. The feed URL is compiled into
  every installed copy and can't move later without a release that still reads the old
  one, so it must not depend on where the files happen to be hosted (GitHub Releases, a
  repo name). The appcast lists the newest 10 builds; the publish step deletes archives
  that drop out of it. Nothing is deleted by age, so a quiet month never breaks updates.
- **Versions**: `sparkle:version` is the build number (the commit count of `main`),
  `sparkle:shortVersionString` the short hash. CI checks out the full history to count.
  Publishing refuses a build number that isn't higher than the newest in the appcast, so
  a re-run of an old commit can't become "latest".
- **A release workflow** (`.github/workflows/release-macos.yml`) on the hosted `xcode-27`
  runner, following `website.yml`: `push` to `main` with a path filter, plus
  `workflow_dispatch` (which builds `main`'s head), a concurrency group that never cancels
  a running publish. It runs the client check itself rather than waiting for CI through
  `workflow_run`, which runs on the default branch with secrets for every CI run,
  including fork PRs, and is easy to get wrong. Two jobs: **build** (check, Release build,
  zip; no secrets, no environment) and **publish** (in the GitHub environment `release`,
  limited to `main`: sign, write the appcast, upload). The build job runs third-party
  code (SwiftPM build plugins, Homebrew tools) that must never share a machine with the
  private key.
- **Signing stays ad hoc** until there is a reason to pay for a Developer ID. What that
  costs: Sparkle's key rotation isn't available, Gatekeeper can't vouch for the app, and
  the first install takes steps. On macOS 27 a build downloaded with a browser is
  quarantined: opening it says "Achtung" Not Opened, with no Open Anyway in that dialog.
  The user goes to System Settings → Privacy & Security → Open Anyway, confirms, and
  enters an administrator password; or runs
  `xattr -dr com.apple.quarantine /Applications/Achtung.app`. The spike (below) showed
  that Sparkle installs an update over an ad-hoc app with no Gatekeeper or quarantine
  prompt, and that settings and the notification permission survive it.
- **A quarantined app runs translocated, and then can't update.** Until the quarantine
  mark is gone (or the user moved the app in Finder), macOS runs it from a read-only
  copy under `/AppTranslocation/`, where an update can't land, while it looks as if it
  ran from Applications. The app detects this from its bundle path, doesn't start the
  updater, and says so with the fix: at launch in the toolbar pill, and on "Check for
  Updates…".
- **UI**: "Check for Updates…" in the app menu and the menu bar menu, without a keyboard
  shortcut; a setting "Check for updates automatically" (on by default, once a day,
  `SUEnableAutomaticChecks`, so Sparkle never asks for permission) with the version and
  build; no automatic installs (`SUAllowsAutomaticUpdates` is off). When an update is
  found, a small toolbar pill shows it, and a popover offers Install and Relaunch, Skip
  or Later, with a link to the commits between the two builds on GitHub. Install and
  Relaunch is the one decision: the download, the check and the relaunch follow without
  a second question. When no main window is on screen as a check begins, Sparkle's
  standard dialogs show that check to its end. A feed or an update that fails its
  signature check is a distinct state, "Update Rejected": it says that nothing was
  installed and that it may have been tampered with, and offers no "try again".
  Sparkle's other errors are shown in its words, with Try Again.
- **Adapted from Ghostty** (MIT, © Mitchell Hashimoto and Ghostty contributors),
  `macos/Sources/Features/Update/`: the custom `SPUUserDriver` that falls back to
  Sparkle's standard driver, the toolbar pill with a progress ring, the popover per
  state, and a simulator that plays the states without a feed. Ours differs: the state
  is plain data in AchtungDomain (`UpdateState`, changed by `UpdateEvent`s, tested on
  Linux), the answer Sparkle waits for is kept apart from it, one presenter shows a
  check from start to end instead of both at once, and there is no permission prompt
  and no automatic download.

## Consequences

- Achtung can be installed from the website by people without Xcode, and stays current.
  The README and the site get an install section; `install.sh` stays for development.
- A local build from a branch with more commits than `main` has a higher build number and
  is never offered an update until `main` passes it. Acceptable for a developer; noted in
  the README.
- Every client change on `main` reaches every installed copy within a day. The client
  check on `main` is now a release gate, not only a check.
- New secrets: the EdDSA private key and an R2 token scoped to the updates bucket. The
  Terraform token gains R2 permission. Losing the private key means installed copies
  can't update any more and must be reinstalled by hand.
- Moving to a Developer ID later is a signing change only. The EdDSA key and the feed
  stay.
- The feed and the key are build settings (`ACHTUNG_UPDATE_FEED_URL`,
  `ACHTUNG_UPDATE_PUBLIC_KEY`), so a test can point one build at a local feed with a
  throwaway key on `xcodebuild`'s command line, without a committed change.
  The release refuses an archive whose app doesn't carry the real feed URL and the public
  key, and whose signature doesn't verify with that key.
- The feed is written by our own script (`macos/scripts/appcast.py`), not by Sparkle's
  `generate_appcast`, which wants every listed archive on disk and decides by itself what
  to keep. Sparkle's `sign_update` signs the archive and the feed; the script, which never
  sees the private key, verifies both with the public key inside the archive, and
  verifies the published feed before it builds on it.
- A copy installed by `install.sh` from a checkout updates itself too: it's a Release
  build with a build number and the key.
- Rejected: GitHub Releases as the feed (ties the feed URL to the repository), checking
  GitHub for a newer commit and building locally (needs Xcode), a self-hosted runner
  (fork PRs on a public repo), `workflow_run` after CI (see above).

## The spike (2026-11-14)

Sparkle 2.10.1, two ad-hoc Release builds, a local feed, a throwaway key, on macOS 27.2:

- Build N found N+1, installed it and relaunched, in about 16 seconds, with no Gatekeeper
  or quarantine prompt; the installed result carried no quarantine mark.
- The EdDSA signature is what accepted it. The two builds' designated requirements differ
  (an ad-hoc one pins the binary's hash), and Sparkle's code-signing fallback said it
  can't work without a team identifier.
- Settings and the notification permission survived.
- A zip with one byte flipped was refused before unpacking ("The update is improperly
  signed…"), and an appcast edited without re-signing was refused without a download
  ("The update feed is improperly signed…").
- With `SURequireSignedFeed` and without `SUVerifyUpdateBeforeExtraction`, the updater
  refused to start, at every launch.
- A quarantined copy was translocated on every launch and couldn't have updated; after
  `xattr -dr com.apple.quarantine` it ran in place and updated normally. Open Anyway
  needs an administrator password, so that route wasn't completed over SSH. That moving
  the app in Finder also ends translocation is macOS's documented behaviour, not
  something the spike could perform.
- The Swift package embeds `Sparkle.framework` with `Autoupdate`, `Updater.app` and, in
  its `XPCServices` folder, Sparkle's Downloader and Installer services (the spike's
  report missed those; the phase 2 build shows them). They are only used by a sandboxed
  app that enables them in `Info.plist`. Achtung isn't sandboxed and doesn't, so they
  stay where they are: removing them would mean changing and re-signing the framework
  for no gain but size.
- Not exercised: Sparkle's grace period for a feed whose signature fails on scheduled
  checks (`SUSignedFeedFailureExpirationInterval`); both refusals were manual checks.
