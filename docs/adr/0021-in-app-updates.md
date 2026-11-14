# 0021: In-app updates with Sparkle

- Status: proposed
- Date: 2026-11-14

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
- **Updates are verified with Sparkle's EdDSA signature.** The public key is in
  `Info.plist` (`SUPublicEDKey`); the private key is the GitHub Actions secret
  `SPARKLE_ED_PRIVATE_KEY` and a copy in the author's password manager. The appcast is
  signed too (`SURequireSignedFeed`), so a compromised bucket can't point the app at a
  foreign build.
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
  costs: a first install downloaded with a browser is quarantined and needs "Open
  Anyway" in System Settings (or `xattr -d com.apple.quarantine`); Sparkle's key rotation
  isn't available; Gatekeeper can't vouch for the app. Phase 1 of the plan checks that
  Sparkle installs an update over an ad-hoc app without a quarantine prompt and that the
  notification permission survives; if either fails, this decision is revisited.
- **UI**: "Check for Updates…" in the app menu and the menu bar menu; a setting "Check
  for updates automatically" (on by default, once a day); no automatic installs. When an
  update is found, a small toolbar pill shows it, and a popover offers Install and
  Relaunch or Skip, modelled on Ghostty's (MIT). When no window is open, Sparkle's
  standard dialog takes over. Debug builds, demo mode and tests never check.

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
- Rejected: GitHub Releases as the feed (ties the feed URL to the repository), checking
  GitHub for a newer commit and building locally (needs Xcode), a self-hosted runner
  (fork PRs on a public repo), `workflow_run` after CI (see above).
