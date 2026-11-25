# AGENTS.md

Achtung is a self-hosted alert inbox. A TypeScript server receives monitoring webhooks
(Alertmanager first), and a native macOS client displays them. This file is a map. Read
the linked docs when your task touches their area.

| Read | When |
|---|---|
| `README.md` | Product context and UX goals |
| `docs/architecture.md` | Layers, data flow, alert identity. Before adding or moving code. |
| `docs/golden-principles.md` | Taste and judgement calls. Before every non-trivial change. |
| `docs/adr/` | Why things are the way they are. Before changing a decision. |

## Commands

Tool versions are pinned in `.tool-versions`. Use pnpm, never npm or yarn.

```bash
pnpm install                        # also installs git hooks (lefthook)
pnpm --dir server run check         # typecheck, lint, architecture, migrations, dead code, duplication, tests (incl. api/openapi.yaml)
pnpm --dir server run fix           # auto-fix formatting and lint
pnpm --dir server exec vitest run test/sources/alertmanager.test.ts   # a single test file
pnpm --dir server run db:generate   # write a migration after changing src/db/schema.ts
pnpm --dir server run api:generate  # rewrite api/openapi.yaml after changing a route or its schema (update macos/scripts/demo-server.py to match)
pnpm --dir server run dev           # run the server locally (needs DATABASE_URL; no build step)
pnpm --dir server run test:mutation # mutation tests (slow; runs nightly in CI)
```

Plugins hand alerts over to programs outside Achtung (ADR 0022). `sdk/typescript/` is the
SDK for writing one, a handler: read `docs/handover-protocol.md` and its `README.md` first.
Its conformance scenarios also run against the real server (`server/test/http/handover-conformance.test.ts`),
so a change to the handler API changes the scenarios and the fake server with it.

```bash
pnpm --dir sdk/typescript run check        # typecheck, lint, dead code, duplication, tests (no Docker)
pnpm --dir sdk/typescript run fix          # auto-fix formatting and lint
pnpm --dir sdk/typescript run dev          # a fake Achtung server on :8790, to try a handler against
```

The public website (achtunk8s.io) is an Astro static site in `website/`. Pushes to `main`
that touch it deploy it to Cloudflare (`.github/workflows/website.yml`, after its check). Read
`website/README.md` before changing it; it is public, so no real hostnames.

```bash
pnpm --dir website run dev          # dev server on :4321
pnpm --dir website run check        # astro check, build, html-validate, link check (must pass for website changes)
pnpm --dir website run astro …      # any other astro command (loads the no-AVX2 compiler fallback)
```

The achtunk8s.io Cloudflare zone and this GitHub repository are configured with Terraform in
`infra/` (read `infra/README.md` first). A push to `main` that touches it applies it
(`.github/workflows/infra.yml`), so infra changes go through a pull request, whose plan is
posted as a comment, unlike the rest. Never run `terraform apply` yourself.

```bash
make -C infra help                  # init, plan, plan-file, target-plan TARGET=…, ids, check, fmt (plans need infra/.envrc)
infra/scripts/check.sh              # terraform fmt -check, validate (no credentials or state)
terraform -chdir=infra fmt -recursive   # auto-fix formatting
```

Tests need Docker: they start a real Postgres with Testcontainers.

The server image is built from the root `Dockerfile` (`docker build .`). It holds the
sources and production dependencies, runs as the `node` user and works with a read-only
root filesystem. CI builds it on every push but never publishes it.

`check` must pass before you finish. A Stop hook and the pre-commit hook enforce this. When
a check fails, fix the cause. Never weaken a rule, raise a threshold, or add an ignore to
get a change through. If you believe a rule is wrong, stop and say why.

## Rules that tools can't check

- **Small, focused changes.** Do one thing per change and leave unrelated code alone. Plan
  first when a change touches several files.
- **Copy the reference.** New source: follow `server/src/sources/alertmanager/` (skill
  `add-source`). Before writing new code, find the closest existing example.
- **Ingest is idempotent.** A repeat notification for an occurrence that is already
  firing updates it and never counts as new. After an hour without an event it records a
  `resent` event, which resurfaces the alert (ADR 0009; the alert identity section in
  `docs/architecture.md`).
- **No auth, no users** (ADR 0002). Don't add login, user tables or per-user state.
- **Tests are part of the change.** A bug fix starts with a failing test. Source
  adapters are tested against anonymized fixtures in `server/test/fixtures/<source>/`.
  Use the real Postgres via Testcontainers, never a mocked database.
- **Never commit** secrets, `.env` files, or payloads containing real hostnames.
- **Ask before** changing the public API shape, the database schema design or the
  deployment, if the task doesn't already cover it.
- **Record decisions.** If a change departs from an ADR, write a new ADR in the same
  change. When you add a tool or command, update this file.
- **Keep the public face current.** When a change adds a feature or changes how the app
  works or looks, update in the same change everything public that describes it:
  `README.md`, the website (`website/`), and the screenshots and clips in `docs/media/`.
  Retake the shots it changes and add shots for a new feature, both listed in
  `docs/media/SHOTLIST.md` with their demo-mode steps (`demo-server.py` may need data for
  them). The README and the site describe what exists today: when a roadmap item ships,
  move it out of the roadmap. Shots need the macOS app; if you can't capture them, say
  which ones are stale or missing instead of leaving them silently out of date.
- **Don't commit, push, create a branch, or open a pull request** unless the user
  explicitly asks for that action. Leave the change uncommitted for review.
- **Commits**, when asked for, use Conventional Commits, e.g. `feat(server): …`,
  `fix(macos): …`, `docs: …`. The commit-msg hook enforces this. Work lands directly on
  `main`, with no branches or pull requests. Several agents may push, so
  `git pull --rebase` before you push. The exception is `infra/`: a push to `main` applies
  it, so its changes go through a pull request whose plan is reviewed first.
- **Review.** Before calling non-trivial work done, run the `reviewer` subagent on the
  diff and fix what it finds that is real.

## macOS client

Swift 6 language mode, latest macOS, SwiftUI with `@Observable`. The Xcode project is
generated by XcodeGen (`macos/project.yml`), so never edit or commit `.xcodeproj`. The
client builds only on macOS. If you are on Linux, say you couldn't build or run it, and
don't claim it works.

```bash
brew install xcodegen swiftlint periphery   # once; Xcode provides swift and swift format
macos/scripts/check.sh              # format, lint, package tests, release script tests, app build and tests, dead code
swift format format -i --recursive macos/Achtung macos/Packages/*/{Package.swift,Sources,Tests}   # auto-fix formatting
swift test --package-path macos/Packages/AchtungDomain             # domain tests (also on Linux)
swift test --package-path macos/Packages/AchtungAPI                # API mapping tests (also on Linux)
cd macos && xcodegen generate && open Achtung.xcodeproj           # work in Xcode
macos/scripts/install.sh            # build-release.sh, installed into ~/Applications
macos/scripts/build-release.sh      # Release build, version = commit hash, build number = commit count; prints the app's path
python3 -B -m unittest discover -s macos/scripts -p 'test_*.py'   # tests of appcast.py, the update feed's script (also on Linux)
macos/scripts/run.sh                # Debug build of the working tree, started (quits a running Achtung)
macos/scripts/demo.sh               # demo mode: run.sh against demo-server.py, a fake server with made-up alerts
curl -X POST 'http://127.0.0.1:8790/demo/fire?count=1'   # demo mode: fire new critical alerts now (/demo/resend resends one), to try notifications
macos/scripts/demo.sh -simulateUpdate available   # demo mode with a made-up update in the toolbar (also up-to-date, tampered-update, tampered-feed, failed, translocated)
curl -X POST http://127.0.0.1:8790/demo/remind           # demo mode: every pending reminder comes due now
make help                           # make run, run-light, demo, install, check, test, xcode: shortcuts for the above
swift macos/scripts/render-icon.swift   # render macos/Icon/AppIcon.svg into the app icon set
macos/scripts/render-coffee-break.sh   # render Live's coffee-break krysa as GIFs into macos/Icon/coffee-break/
```

`check.sh` must pass before you finish, like the server's `check`. The Stop hook and the
pre-commit hook run it only on macOS. On Linux only the package tests run, so CI is the
gate for everything else. Tooling and CI choices: ADR 0004.

In-app updates use Sparkle (ADR 0021; `macos/Achtung/Updates/`), pinned to an exact
version in `project.yml`. The updater only exists in a Release build with a build number
and a public key (`ACHTUNG_UPDATE_PUBLIC_KEY` in `project.yml`, the public half of the
user's signing key: never generate or commit a key yourself, and never print a private
one). The feed URL (`ACHTUNG_UPDATE_FEED_URL`) is compiled into every installed copy, so
don't change either. To test against a local feed with a throwaway key, override both on
the command line (`build-release.sh` passes its arguments to `xcodebuild`), never in the
file.

**A push to `main` that touches `macos/`, `api/openapi.yaml` or the workflow publishes
the client to every installed copy** (`.github/workflows/release-macos.yml`, ADR 0021):
`check.sh`, then `build-release.sh`, on one machine without secrets; then on another, in
the GitHub environment `release` (only `main` may use it), `sign-release.sh` signs the
archive and the feed and the workflow uploads them to the R2 bucket behind
`updates.achtunk8s.io`. So `check.sh` is a release gate: don't push a client change you
wouldn't install. The environment's secrets are `SPARKLE_ED_PRIVATE_KEY` and
`UPDATES_R2_ACCESS_KEY_ID` / `UPDATES_R2_SECRET_ACCESS_KEY` (setup: `infra/README.md`).
The private key reaches `sign_update` on stdin only; keep it out of arguments, files,
`set -x` and the build job, and don't add a step to the publish job that runs code from
the build's archive or from outside this repository. `appcast.py` writes the feed
(newest 10 builds, never a build number that isn't higher than the feed's) and verifies
everything signed with the public key in the app; its tests run in `check.sh`.

`AchtungAPI` is generated at build time from `api/openapi.yaml` (through a symlink) by
swift-openapi-generator's build plugin; no generated code is committed. The first build
in Xcode asks you to trust the plugin ("Trust & Enable"); `check.sh` passes
`-skipPackagePluginValidation` instead. When the spec changes, rebuild and fix the
mapping in `Packages/AchtungAPI/Sources/AchtungAPI/Mapping.swift`. Its tests use JSON
fixtures in `Packages/AchtungAPI/Tests/AchtungAPITests/Fixtures/`, captured from a real
server (no real hostnames) and extended by hand when the spec adds a field before a server
has it. A channel is identified by its instance and name (`ChannelID`, ADR 0006), never by
the name alone.
