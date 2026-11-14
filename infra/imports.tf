# What was set up by hand before Terraform, imported so the first apply adopts it instead
# of creating it again. The import blocks are harmless once the resources are in the
# state and can be deleted after the first apply. IDs: scripts/discover-ids.sh.

# --- Cloudflare -------------------------------------------------------------------------

# Zone settings always exist, so they are imported, never created.
import {
  for_each = local.zone_settings
  to       = cloudflare_zone_setting.site[each.key]
  id       = "${local.zone_id}/${each.key}"
}

import {
  to = cloudflare_zone_setting.hsts
  id = "${local.zone_id}/security_header"
}

# DNSSEC has a state whether it's on or off.
import {
  to = cloudflare_zone_dnssec.site
  id = local.zone_id
}

# Fill in from scripts/discover-ids.sh (the AAAA record www.achtunk8s.io).
import {
  to = cloudflare_dns_record.www
  id = "${local.zone_id}/REPLACE_WITH_WWW_RECORD_ID"
}

# Fill in from scripts/discover-ids.sh (the zone's http_request_dynamic_redirect ruleset).
import {
  to = cloudflare_ruleset.redirects
  id = "zones/${local.zone_id}/REPLACE_WITH_REDIRECT_RULESET_ID"
}

# --- GitHub -----------------------------------------------------------------------------

import {
  to = github_repository.achtunk8s
  id = local.repository
}

import {
  to = github_repository_vulnerability_alerts.achtunk8s
  id = local.repository
}

import {
  to = github_repository_dependabot_security_updates.achtunk8s
  id = local.repository
}
