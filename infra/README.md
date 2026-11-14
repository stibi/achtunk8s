# Infra

Terraform for the achtunk8s.io zone on Cloudflare and for this GitHub repository. Why:
[ADR 0020](../docs/adr/0020-infrastructure-as-code.md).

Changes go through a pull request: the `Infra` workflow posts the plan as a comment (and
updates it on every push). Merging applies: a push to `main` that touches `infra/` plans
again and applies exactly that plan, in the GitHub environment `infra`. Never apply from a
laptop. A setting changed in a dashboard is reverted by the next apply; change it here.

## What is managed

| Where | Managed here | Not here |
|---|---|---|
| Cloudflare | Zone settings: Always Use HTTPS, minimum TLS 1.2, TLS 1.3, HSTS (6 months, subdomains, no preload) | The zone itself (looked up, never created or deleted), the registrar (Cloudflare Registrar; the provider has no resource for its settings: auto-renew and lock are set in the dashboard), the nameservers |
| | DNSSEC | The DS record: Cloudflare Registrar adds it itself |
| | DNS: `www` (`AAAA 100::`, proxied), null MX, SPF, DMARC, the optional Search Console TXT | The Worker `achtunk8s-website` and its custom domain `achtunk8s.io` with its DNS record: wrangler (`website/wrangler.jsonc`) |
| | The `www` → apex redirect rule (301, path and query kept) | |
| | Web Analytics, automatic setup | |
| GitHub | The repository: description, homepage, topics, features, merge settings, secret scanning and push protection | Actions secrets (values would land in the state; listed below) |
| | Dependabot alerts and security updates | The social preview image (no API: Settings → General → Social preview) |
| | The `main` ruleset: no deletion, no force push | |
| | The environment `infra`, deployable from `main` only | |

The repository can't be deleted by Terraform: it has `prevent_destroy`, and a destroy
would archive it instead.

The domain sends no mail, so the email records say so: `MX 0 .` (RFC 7505),
`v=spf1 -all` and `v=DMARC1; p=reject;`. For DMARC reports, set `dmarc_rua`. A wildcard
null DKIM record (`*._domainkey`, `v=DKIM1; p=`) would add a little more; it isn't set.

### Variables

Set them in `infra/terraform.tfvars` (committed; nothing in them is secret):

```hcl
google_site_verification = "abc123…"           # Search Console's TXT token, without "google-site-verification="
dmarc_rua                = "mailto:dmarc@example.com"   # DMARC aggregate reports
```

`cloudflare_account_id` comes from the `CLOUDFLARE_ACCOUNT_ID` secret.

## Check

```bash
infra/scripts/check.sh    # terraform fmt -check, validate; no credentials or state
```

It runs in CI, the pre-commit hook and the Stop hook for changes in `infra/`. Fix the
formatting with `terraform -chdir=infra fmt -recursive`.

## Bootstrap, once

1. **State bucket.** Cloudflare dashboard → R2 → Create bucket `achtunk8s-tfstate`
   (location automatic, standard storage). R2 must be enabled on the account first.
2. **State keys.** R2 → Manage API tokens → Create Account API token, named
   "achtunk8s terraform state": permission **Object Read & Write**, applied to the bucket
   `achtunk8s-tfstate` only. Keep the Access Key ID and the Secret Access Key. The
   endpoint is `https://<account_id>.r2.cloudflarestorage.com`.
3. **Cloudflare token.** My Profile → API Tokens → Create Token → Custom token, named
   "achtunk8s terraform", separate from the deploy token:

   | Scope | Permission | Access | For |
   |---|---|---|---|
   | Zone | Zone | Read | Looking up the zone |
   | Zone | Zone Settings | Edit | TLS, HTTPS, HSTS |
   | Zone | DNS | Edit | Records and DNSSEC |
   | Zone | Single Redirect | Edit | The `www` redirect rule |
   | Account | Account Settings | Edit | Web Analytics (the API needs it to create a site) |

   Zone resources: Specific zone → `achtunk8s.io`. Account resources: only this account.
4. **GitHub token.** Settings → Developer settings → Fine-grained tokens → Generate,
   named "achtunk8s terraform", resource owner `stibi`, Only select repositories →
   `achtunk8s`. Repository permissions: **Administration: Read and write** (settings,
   topics, security features, rulesets, environments) and **Metadata: Read** (required).
   The workflow's own `GITHUB_TOKEN` can't change repository settings. It expires; renew
   it before it does.
5. **Secrets.** Repository → Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `TF_CLOUDFLARE_API_TOKEN` | The Cloudflare token (3) |
   | `CLOUDFLARE_ACCOUNT_ID` | The account ID (already there for the website) |
   | `TF_STATE_ACCESS_KEY_ID` | R2 Access Key ID (2) |
   | `TF_STATE_SECRET_ACCESS_KEY` | R2 Secret Access Key (2) |
   | `TF_GITHUB_TOKEN` | The GitHub token (4) |

   They are repository secrets, not environment secrets, because pull requests plan too.
   So any branch's workflow can read the write tokens. Stricter, for later: read-only
   tokens for the plan job as repository secrets, and the write tokens as secrets of the
   `infra` environment, which only `main` can deploy to.
6. **Imports.** `imports.tf` adopts what exists. Two IDs must be filled in: run
   `scripts/discover-ids.sh` (Run locally, below) and replace `REPLACE_WITH_WWW_RECORD_ID` and
   `REPLACE_WITH_REDIRECT_RULESET_ID`. The script also prints the redirect rules, the zone
   settings changed by hand and the DNS records. Make `cloudflare.tf` match anything set
   by hand that it doesn't have yet, so the first plan changes only what's meant to.
7. **First plan.** Plan locally (Run locally, below), then open a pull request with the IDs and read the
   plan in its comment: imports, the new records, Web Analytics and the GitHub settings,
   nothing destroyed. Expected noise: `has_downloads` on the repository goes to null (a
   retired GitHub feature the provider no longer sets). Land `infra/` on `main` only with
   the IDs filled in and the secrets in place: the push runs the apply.
8. **Apply.** Merge. The `Infra` workflow applies in the environment `infra`; GitHub
   creates it on that first run, and the apply restricts it to `main`.
9. **DNSSEC.** Nothing to do: the domain is registered with Cloudflare Registrar, which
   adds the DS record itself (CDS/CDNSKEY scanning, one to two days). Until it's
   published, Cloudflare reports DNSSEC as `pending`, and plans show
   `status: "pending" -> "active"`. `dig +short DS achtunk8s.io` shows it once it's there.
10. **Check.** `dig +short MX achtunk8s.io` gives `0 .`; the site's HTML has the
    `cloudflareinsights.com` beacon; the repository shows its description and topics.

To make every apply wait for an approval, add `reviewers { users = [<your user id>] }` to
`github_repository_environment.infra` (`gh api user --jq .id`). Not in the dashboard: the
next apply would remove it.

## Run locally

The credentials come from the environment, with [direnv](https://direnv.net):

```bash
cp infra/.envrc.example infra/.envrc && direnv allow   # then fill in infra/.envrc
```

`infra/.envrc` is gitignored; `.envrc.example` lists every variable Terraform, the s3
backend and `discover-ids.sh` need, and where each comes from. `GITHUB_TOKEN` may be the
fine-grained PAT or your own `$(gh auth token)`: a plan only reads.

```bash
cd infra
make ids                              # import IDs and what was set by hand; read-only
make init
make plan                             # -lock=false: a local plan doesn't hold the state lock
make plan-file                        # the same, into a temp file, with the summary on screen
make target-plan TARGET='cloudflare_dns_record.www github_repository.achtunk8s'
```

`make help` lists the targets (`Makefile`). There is no apply target on purpose.

Never apply locally; merging the pull request applies.

## Imports later

Something made by hand that should be managed: add its resource and an `import` block in
`imports.tf` with its ID (the provider's docs give each resource's import ID format), and
open a pull request. The plan shows `will be imported`. Once applied, the block can go.
