# Plan: "Check for Updates" in the macOS client

Status: **phases 1 to 3 done** (the spike, 2026-11-14; the app, 2026-11-15, run against
a local feed on 2026-11-18; the hosting, infra PR #16, applied 2026-11-18). **Phase 4 is
written and rehearsed, not yet run for real**: the first push of the workflow to `main`
publishes the first release. Decision: ADR 0021 (accepted).

Reference: Ghostty's updater (`macos/Sources/Features/Update/` in ghostty-org/ghostty,
MIT) and its `.github/workflows/release-tip.yml` and `dist/macos/update_appcast_tip.py`.
Adapt, don't copy wholesale.

---

## Phase 1: spike, prove ad-hoc updates work — done

Passed on the Mac mini with Sparkle 2.10.1, a throwaway key and a local feed: an ad-hoc
build updates to the next ad-hoc build and relaunches without a Gatekeeper prompt,
settings and the notification permission survive, and a tampered archive and a tampered
appcast are both refused. What it changed in the plan: `SUVerifyUpdateBeforeExtraction`
is required; EdDSA is the only protection with ad-hoc signing; a quarantined copy runs
translocated and can't update; Open Anyway needs an administrator password on macOS 27;
`generate_keys` needs a desktop session. Sparkle's XPC services are inside its framework
and unused without sandboxing, so they are left there, not stripped. The details
are in ADR 0021, "The spike".

## Phase 2: the app — done

- `project.yml`: Sparkle as a package at exactly 2.10.1. Its keys are in
  `targets.Achtung.info.properties`: `SUFeedURL` and `SUPublicEDKey` (from the build
  settings `ACHTUNG_UPDATE_FEED_URL` and `ACHTUNG_UPDATE_PUBLIC_KEY`), `SURequireSignedFeed`,
  `SUVerifyUpdateBeforeExtraction`, `SUEnableAutomaticChecks`, `SUScheduledCheckInterval`
  (86400), `SUAllowsAutomaticUpdates` (off).
- The public key went into `project.yml` with phase 4, not before: with it set,
  installed builds check the feed, which didn't exist until the first release.
- `macos/Achtung/Updates/`: `UpdateController` (owns `SPUUpdater`, made by `AchtungApp`,
  started only when `UpdaterAvailability` is `active`), `UpdateDriver` (the custom
  `SPUUserDriver`, Sparkle's standard dialogs without a window), `UpdateModel`, the
  toolbar pill and popover, "Check for Updates…" in both menus, Settings' toggle with
  the version and build, and `UpdateSimulator` (Debug only).
- AchtungDomain: `UpdaterAvailability`, `UpdateState`, `UpdateEvent`, `UpdateFailure`,
  `AvailableUpdate`, with tests.
- Docs: `docs/architecture.md` and `docs/media/SHOTLIST.md`. The README's install section, the website's download button and the roadmap
  wait for phase 4, when there is something to download.

Run on the Mac mini on 2026-11-18 as in the spike (two ad-hoc Release builds, 100000 and
100001, a throwaway key, a local feed): the scheduled check at launch showed the pill
alone; "Check for Updates…" opened its popover; Install and Relaunch downloaded, verified,
installed and relaunched the new build within about a second, with no prompt and no
quarantine mark; the new build said "Up to Date", which went away by itself; an archive
with one byte flipped and an appcast edited without re-signing each ended in "Update
Rejected" with its own text, the old build untouched; and with the window closed Sparkle's
standard dialog offered the update. Not run live: the translocation message (the simulator
shows it; the detection is tested in AchtungDomain), Try Again after an ordinary failure,
and a check from the menu bar with the window behind another app.

Known wart: the window's search field sits beside the title, and moves to the toolbar's
trailing end while the pill is shown.

### The signing key — generated

The user generated it on the Mac mini (Keychain account `achtunk8s`). The public key,
which is not a secret:

```
gMyt7e6UldwpjoBjxrjUhnIqrpStcUEBFfK2tzWcRt8=
```

It is `ACHTUNG_UPDATE_PUBLIC_KEY` in `macos/project.yml` since the phase 4 change. How
it was made:

At the Mac mini's or the MacBook's desktop (not over SSH: `generate_keys` writes to the
login Keychain):

1. Get Sparkle's tools at the app's version:
   `curl -LO https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz`,
   compare its SHA-256 with the release page's, unpack it; the tools are in `bin/`.
2. `bin/generate_keys --account achtunk8s` creates the key pair in the login Keychain
   and prints the **public** key (run it again with `-p` to print it later).
3. The public key goes into `macos/project.yml`, as `ACHTUNG_UPDATE_PUBLIC_KEY`. It is
   not a secret.
4. `bin/generate_keys --account achtunk8s -x sparkle-private-key.txt` exports the
   **private** key to a file. Put its contents into the password manager and into the
   GitHub environment `release` as the secret `SPARKLE_ED_PRIVATE_KEY` (phase 3), then
   delete the file (`rm -P`). Never paste it into a terminal an agent can read, a
   commit or a chat.
5. Optionally remove it from the Keychain afterwards (Keychain Access, "Private key for
   signing Sparkle updates", account `achtunk8s`): CI and the password manager are the
   two copies the ADR names.

Until the first build is published, a key can still be replaced. After that, losing it
means every installed copy has to be reinstalled by hand.

## Phase 3: hosting (infra PR #16) — done

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

## Phase 4: release workflow — written and rehearsed

`.github/workflows/release-macos.yml`, following `website.yml`:

- `on: push` to `main` with `paths: macos/**, api/openapi.yaml,
  .github/workflows/release-macos.yml`, plus `workflow_dispatch`, which builds `main`'s
  head (any other ref is refused, by a step and by the environment).
- `permissions: contents: read`; `actions/checkout` with `persist-credentials: false`
  and, in the build job, `fetch-depth: 0` (the build number is the commit count).
- `concurrency: release-macos`, `cancel-in-progress: false`.
- **Job `build`** (`runs-on: xcode-27`, no environment, no secrets): `check.sh`, a clean
  tree, `macos/scripts/build-release.sh` (which `install.sh` also calls),
  `ditto -c -k --keepParent`, and the archive as a workflow artifact.
- **Job `publish`** (`needs: build`, `environment: release`, a fresh `macos-latest`
  runner, since Sparkle's tools are macOS binaries; nothing is built, and nothing from the
  archive is run):
  - Sparkle's `sign_update` at the app's version, checksum-verified.
  - The published feed, fetched from the bucket after listing it, so a failed download
    can't pass for the first release.
  - `macos/scripts/sign-release.sh`, with the private key on stdin:
    1. the guard (`appcast.py app`): the archive holds only `Achtung.app`, whose
       `Info.plist` has `SURequireSignedFeed`, `SUVerifyUpdateBeforeExtraction`, no
       automatic installs, a public key, the real feed URL, a positive build number and
       this commit's hash as its version (so not `-dirty`);
    2. `sign_update --ed-key-file -` signs the archive;
    3. `appcast.py add` verifies that signature and the published feed's with the public
       key in the app, refuses a build number that isn't higher than the feed's newest,
       and writes the feed with the new build on top, the newest 10;
    4. `sign_update` signs the feed, and `appcast.py check` verifies the result.
  - Upload through R2's S3 API: the archive (`immutable`), then `Achtung-latest.zip`
    (`no-cache`, for the website's download link), then the appcast (`no-cache`) last, so
    the switch is atomic. Then delete the numbered archives the feed no longer lists
    (`appcast.py stale`).
  - Smoke check: the feed at `updates.achtunk8s.io` verifies and offers the new build,
    and both archive addresses serve its bytes.
- `appcast.py` has tests (`test_appcast.py`: ordering, the newest 10, the monotonic
  guard, the Info.plist guard, signatures), run by `check.sh`, so by CI and by the
  release itself. It differs from the first plan in one thing: Sparkle's
  `generate_appcast` isn't used (ADR 0021, Consequences).
- The README has the install section and an Updates section; the website has the
  download link and button. Neither had a roadmap entry for this.
- AGENTS.md: the scripts, the test command, and a paragraph on the release workflow and
  its secrets.

Rehearsed on the Mac mini on 2026-11-18, with throwaway keys and a throwaway git
repository of the tree: `build-release.sh` with the committed settings gives an app with
the real key and feed URL that passes the guard, and leaves the tree clean; `sign_update`
fetched as the workflow does; a first release and a second one through `sign-release.sh`;
Sparkle's own `sign_update --verify` accepts the feed and the archive signature; the
installed first build found the second in that feed, installed it and relaunched. Refused,
with no key in the output: a missing feed that isn't declared the first release, a second
"first" release, the same or an older build, another commit's build, a build that reads
another feed, a wrong private key (also for a build with the real public key), a key that
isn't one, and no key.

Only the first real run can show: the secrets' values (that `SPARKLE_ED_PRIVATE_KEY` is
the exported key and belongs to the public key: if not, the run stops before any upload),
the R2 keys and the AWS CLI against R2 (listing, upload with headers, delete), the
`release` environment on the hosted runners, the artifact hand-over between the two jobs,
and what Cloudflare's cache does with the three objects. After it: install the download
on a Mac through the browser, and check the first-launch steps and the Finder move, which
the spike couldn't perform.

## Answered (2026-11-14)

- Tip only, no waiting for a "stable" channel.
- Developer ID later.
- The website gets a download button (`tip/Achtung-latest.zip`), in phase 4, when the
  file exists.
