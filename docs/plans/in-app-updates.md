# Plan: "Check for Updates" in the macOS client

Status: **planned, not started** (written 2026-11-14). Decision: ADR 0021 (proposed).
It changes the deployment, so each phase waits for the user's OK. Infra goes through a
pull request (AGENTS.md).

Reference: Ghostty's updater (`macos/Sources/Features/Update/` in ghostty-org/ghostty,
MIT) and its `.github/workflows/release-tip.yml` and `dist/macos/update_appcast_tip.py`.
Adapt, don't copy wholesale.

---

## Phase 1: spike, prove ad-hoc updates work (local, throwaway)

Before building anything to keep, answer the open questions on the MacBook, with a
throwaway branch and a local feed (`python3 -m http.server`):

1. Add Sparkle (latest 2.x, 2.10.1 at the time of writing) and a bare
   `SPUStandardUpdaterController`.
2. `generate_keys --account achtunk8s-spike` for a throwaway key.
3. Build build N, install it to `~/Applications`. Build N+1, zip with `ditto -c -k
   --keepParent`, `generate_appcast` into the local feed.
4. Check, and record in the ADR:
   - N finds N+1, installs and relaunches it, with no Gatekeeper or quarantine prompt.
   - The ad-hoc signature of N+1 passes Sparkle's checks (it compares code signatures
     when the old app is signed; the ad-hoc case is the unknown).
   - Notification permission and the app's settings survive the update.
   - A tampered zip and a tampered appcast are rejected.
   - The zip downloaded with Safari (quarantined) shows which first-install steps a user
     needs. They go into the README.
5. Remove the throwaway key from the Keychain.

If the ad-hoc case fails, stop: the options are a Developer ID (99 USD/year) or dropping
the feature. Ask the user.

## Phase 2: the app

- `project.yml`: the Sparkle package, exact version. Sparkle's keys go in
  `targets.Achtung.info.properties`, next to `NSAppTransportSecurity` (`INFOPLIST_KEY_*`
  only covers keys Xcode knows): `SUFeedURL`
  (`https://updates.achtunk8s.io/tip/appcast.xml`), `SUPublicEDKey`,
  `SURequireSignedFeed`, `SUEnableAutomaticChecks`, `SUScheduledCheckInterval` (86400).
  Sparkle's XPC services aren't needed (not sandboxed); strip them if the build embeds
  them.
- `Updates/UpdateController.swift`: owns `SPUUpdater`, started at launch from `AppModel`.
  Not started in demo mode, `run.sh`, previews or tests, and when the build number is 0
  (a Debug build), so development builds never replace themselves.
- `Updates/UpdateDriver.swift` + `UpdateModel` (`@Observable`): a custom
  `SPUUserDriver` mapping Sparkle's callbacks to states (idle, checking, available,
  downloading with progress, extracting, ready to install, up to date, error), falling
  back to `SPUStandardUserDriver` when no window is open. Ghostty's `UpdateDriver` and
  `UpdateState` are the reference.
- UI:
  - "Check for Updates…" after "About Achtung" (`CommandGroup(after: .appInfo)`) and in
    `MenuBarMenu`.
  - A toolbar pill in the main window when the state isn't idle; its popover shows
    version, date, size, a release notes link (the compare view on GitHub) and Install
    and Relaunch / Skip / Later.
  - Settings: "Check for updates automatically" bound to
    `automaticallyChecksForUpdates`; shows the current version and build.
- Tests: the state mapping in `UpdateModel` with a fake driver input (Swift Testing),
  no network. An `UpdateSimulator` for demo mode so the pill can be seen and
  screenshotted without a feed.
- Docs: `docs/architecture.md` (the updater and when it is off), README (install from
  the website, first-launch steps, updates), the website (install section and download
  link), `docs/media/SHOTLIST.md` + a shot of the pill and popover. Move the item out of
  the roadmap if it's there.

## Phase 3: hosting (infra PR)

- `cloudflare_r2_bucket` `achtunk8s-updates` and `cloudflare_r2_custom_domain`
  `updates.achtunk8s.io`. No lifecycle rule: the publish step deletes archives that drop
  out of the appcast, so nothing it lists or aliases can expire.
- The Terraform Cloudflare token needs an account-level "Workers R2 Storage: Edit"
  permission; update the token table in `infra/README.md`.
- The GitHub environment `release` with a deployment policy for `main`, as a Terraform
  resource next to `github_repository_environment.infra` in `infra/github.tf`.
- An R2 API token scoped to the updates bucket, object read/write, for CI. Created by hand
  (a token in state is a secret), documented in `infra/README.md`.
- Secrets the user sets in the `release` environment: `SPARKLE_ED_PRIVATE_KEY`,
  `UPDATES_R2_ACCESS_KEY_ID`, `UPDATES_R2_SECRET_ACCESS_KEY`. `CLOUDFLARE_ACCOUNT_ID`
  already exists.

## Phase 4: release workflow

`.github/workflows/release-macos.yml`, following `website.yml`:

- `on: push` to `main` with `paths: macos/**, api/openapi.yaml,
  .github/workflows/release-macos.yml`, plus `workflow_dispatch`, which builds `main`'s
  head (refuse any other ref).
- `permissions: contents: read`; `actions/checkout` with `persist-credentials: false`
  and `fetch-depth: 0` (the build number is the commit count).
- `concurrency: release-macos`, `cancel-in-progress: false`.
- **Job `build`** (`runs-on: xcode-27`, no environment, no secrets):
  - `xcode-select` 27.2 and the Homebrew tools as in CI, then `macos/scripts/check.sh`.
  - Build Release with `MARKETING_VERSION=<short hash>` and
    `CURRENT_PROJECT_VERSION=<commit count>`, through a new `macos/scripts/build-release.sh`
    that `install.sh` also calls (update its header comment).
  - `ditto -c -k --keepParent Achtung.app Achtung-<build>.zip`, uploaded as a workflow
    artifact with the build number and hash.
- **Job `publish`** (`needs: build`, `environment: release`, a fresh `macos-latest`
  runner, since Sparkle's tools are macOS binaries; no Xcode build, no plugins). The environment's `main` policy holds
  because the trigger is `push`; keep it that way.
  - Download Sparkle's tools at the pinned version, checksum-verified.
  - Fetch the current appcast. Refuse to publish unless the new build number is higher
    than its newest item.
  - `sign_update` with the key from the secret through stdin (`--ed-key-file -`), never on
    disk or in logs.
  - Write the appcast: add the new item, keep the newest 10, sign it. A small script in
    `macos/scripts/`, with tests (ordering, trimming, the monotonic guard), like Ghostty's
    `update_appcast_tip.py`.
  - Upload the zip (`Cache-Control: immutable`), then `Achtung-latest.zip` (`no-cache`, for
    the website's download link), then the appcast (`no-cache`) last, so the switch is
    atomic. Then delete the archives no longer listed.
  - Smoke check: fetch the appcast through `updates.achtunk8s.io` and verify it lists the
    new build.
- AGENTS.md: add `build-release.sh`, the appcast script and its test command, and a
  paragraph on the release workflow and its secrets, as for the website and infra.

## Answered (2026-11-14)

- Tip only, no waiting for a "stable" channel.
- Developer ID later.
- The website gets a download button (`tip/Achtung-latest.zip`) in phase 2.
