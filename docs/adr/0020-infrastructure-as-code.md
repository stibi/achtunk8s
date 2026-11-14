# 0020: The site's zone and the repository as code

- Status: accepted
- Date: 2026-11-14

## Context

The achtunk8s.io zone on Cloudflare (TLS settings, the `www` redirect, DNS) and the
GitHub repository's settings were set up by hand in two dashboards. Nothing recorded what
was set or why, a change left no trace, and new work was waiting: email anti-spoofing
records, DNSSEC, Web Analytics, a Search Console record, the repository's description and
topics, and a guard against force-pushing `main`.

## Decision

- **Terraform in `infra/`** manages them, one root module and one state. Terraform, not
  OpenTofu, at the version in `.tool-versions`; the providers `cloudflare/cloudflare` (v5)
  and `integrations/github` (v6) are pinned exactly, with `.terraform.lock.hcl` committed
  for Linux and Apple silicon.
- **State in Cloudflare R2**, through the `s3` backend, locked with a lock file
  (`use_lockfile`, S3 conditional writes). The site already lives on Cloudflare, so this
  adds no provider and no bill. The bucket is created once by hand. The endpoint names the
  account, so it comes from the environment, not the code.
- **GitHub Actions plans and applies** (`.github/workflows/infra.yml`): a pull request gets
  a plan as a comment, a push to `main` plans and applies that saved plan in the `infra`
  environment, one apply at a time. Credentials are repository secrets: a Cloudflare
  token and a fine-grained GitHub token for Terraform only, and R2 keys for the state.
  Nobody applies from a laptop.
- **Infra changes go through a pull request**, unlike the rest of the repository, which
  lands on `main` directly: the plan is the review.
- **What Terraform never owns**, so nothing fights over it: the Worker and its custom
  domain (wrangler, `website/wrangler.jsonc`), the zone itself, the registrar and the
  nameservers (looked up, never created or deleted), and Actions secrets (their values
  would land in the state). The repository has `prevent_destroy` and archives on destroy.
- **What existed is imported** (`import` blocks), so the first apply adopts the hand-made
  setup and only adds what's new.
- **The `main` ruleset blocks deletion and force pushes, nothing else.** Requiring pull
  requests or reviews would stop agents and people from pushing straight to `main`.

## Consequences

- A setting changed in a dashboard is reverted by the next apply. Change it in `infra/`.
- The plan of a pull request is public (the repository is), so nothing secret may be in
  it: the account ID is a sensitive variable, and secrets are never managed.
- Pull requests from forks get `fmt` and `validate`, not a plan: they get no secrets.
- Same-repository pull requests can read the Terraform secrets in their plan job. Only
  people with write access can open those.
- Some things have no API and stay manual, listed in `infra/README.md`: the repository's
  social preview image and the DS record at the registrar.
