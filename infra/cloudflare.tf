# The achtunk8s.io zone on Cloudflare. The zone itself (and the registrar and nameservers)
# is set up by hand and only looked up here, so Terraform can never delete it. The Worker
# and its custom domain belong to wrangler (website/wrangler.jsonc), not to Terraform.

locals {
  zone_name = "achtunk8s.io"
  zone_id   = data.cloudflare_zone.site.id

  # Zone settings with a plain value. HSTS (security_header) is an object, below.
  zone_settings = {
    always_use_https = "on"
    min_tls_version  = "1.2"
    tls_1_3          = "on"
  }
}

data "cloudflare_zone" "site" {
  filter = {
    name    = local.zone_name
    account = { id = var.cloudflare_account_id }
  }
}

# --- TLS and HTTPS --------------------------------------------------------------------

resource "cloudflare_zone_setting" "site" {
  for_each = local.zone_settings

  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value
}

# HSTS: six months, subdomains included, not preloaded (preload is hard to undo).
resource "cloudflare_zone_setting" "hsts" {
  zone_id    = local.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 15552000
      include_subdomains = true
      preload            = false
      nosniff            = false
    }
  }
}

# Signs the zone. Cloudflare Registrar publishes the DS record itself within a day or two;
# until then DNSSEC stays pending and resolvers don't validate.
resource "cloudflare_zone_dnssec" "site" {
  zone_id = local.zone_id
  status  = "active"
}

# --- www redirect -----------------------------------------------------------------------

# www only exists to be redirected: the redirect rule acts on proxied traffic only, and
# 100:: is a placeholder origin that is never reached.
resource "cloudflare_dns_record" "www" {
  zone_id = local.zone_id
  name    = "www.${local.zone_name}"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

# The zone's single-redirect ruleset (one per zone and phase). www → apex with a 301,
# keeping the path and the query string. This is the form the dashboard's wildcard
# pattern produces, so the imported rule from the dashboard plans without changes.
resource "cloudflare_ruleset" "redirects" {
  zone_id = local.zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"

  rules = [
    {
      description = "www to apex"
      expression  = "(http.request.full_uri wildcard r\"https://www.${local.zone_name}/*\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "wildcard_replace(http.request.full_uri, r\"https://www.${local.zone_name}/*\", r\"https://${local.zone_name}/$${1}\")"
          }
        }
      }
    },
  ]
}

# --- Email anti-spoofing ----------------------------------------------------------------

# The domain sends and receives no mail. Say so, so nobody can send mail as it:
# a null MX (RFC 7505), an SPF record that allows no sender, and DMARC p=reject.
# TXT contents are quoted, as Cloudflare recommends.

resource "cloudflare_dns_record" "null_mx" {
  zone_id  = local.zone_id
  name     = local.zone_name
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 1
}

resource "cloudflare_dns_record" "spf" {
  zone_id = local.zone_id
  name    = local.zone_name
  type    = "TXT"
  content = "\"v=spf1 -all\""
  ttl     = 1
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = local.zone_id
  name    = "_dmarc.${local.zone_name}"
  type    = "TXT"
  content = var.dmarc_rua == null ? "\"v=DMARC1; p=reject;\"" : "\"v=DMARC1; p=reject; rua=${var.dmarc_rua};\""
  ttl     = 1
}

# --- Google Search Console --------------------------------------------------------------

resource "cloudflare_dns_record" "google_site_verification" {
  count = var.google_site_verification == null ? 0 : 1

  zone_id = local.zone_id
  name    = local.zone_name
  type    = "TXT"
  content = "\"google-site-verification=${var.google_site_verification}\""
  ttl     = 1
}

# --- Web Analytics ----------------------------------------------------------------------

# Cookieless page-view analytics. Automatic setup injects the beacon into proxied HTML;
# the site's CSP (branch website-headers) must allow static.cloudflareinsights.com and
# cloudflareinsights.com.
resource "cloudflare_web_analytics_site" "site" {
  account_id   = var.cloudflare_account_id
  zone_tag     = local.zone_id
  auto_install = true
}

# --- App updates ------------------------------------------------------------------------

# Where the macOS client's updates live: the Sparkle appcast and the app archives
# (ADR 0021), served at https://updates.achtunk8s.io. The release workflow writes the
# objects; Terraform owns only the bucket and its domain. The feed URL is compiled into
# every installed copy, so neither the bucket nor the domain may go away.
#
# No lifecycle rule on purpose: the release workflow deletes archives that drop out of the
# appcast. Deleting by age would break updates after a quiet month.
resource "cloudflare_r2_bucket" "updates" {
  account_id    = var.cloudflare_account_id
  name          = "achtunk8s-updates"
  location      = "weur"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# Public read access to the bucket, through the zone (and its cache). The bucket's
# r2.dev address stays off. Creates the DNS record itself.
resource "cloudflare_r2_custom_domain" "updates" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.updates.name
  domain      = "updates.${local.zone_name}"
  zone_id     = local.zone_id
  enabled     = true
  min_tls     = "1.2"
}
