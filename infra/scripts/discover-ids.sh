#!/usr/bin/env bash
# Prints what imports.tf needs from Cloudflare, and what was set by hand, so the
# configuration can match it before the first apply. Read-only: GET requests only.
#
# Reads CLOUDFLARE_API_TOKEN (the Terraform token) and CLOUDFLARE_ACCOUNT_ID from the
# environment, e.g. from infra/.envrc via direnv (README.md, Run locally).
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
zone_name=achtunk8s.io
api=https://api.cloudflare.com/client/v4

get() {
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api$1"
}

zone_id=$(get "/zones?name=$zone_name&account.id=$CLOUDFLARE_ACCOUNT_ID" | jq -r '.result[0].id // empty')
if [[ -z "$zone_id" ]]; then
  echo "zone $zone_name not found in the account" >&2
  exit 1
fi
echo "zone_id: $zone_id"

echo
echo "== imports.tf"
www=$(get "/zones/$zone_id/dns_records?type=AAAA&name=www.$zone_name" | jq -r '.result[0].id // "none (remove its import block; Terraform creates it)"')
echo "www AAAA record id (REPLACE_WITH_WWW_RECORD_ID): $www"
redirects=$(get "/zones/$zone_id/rulesets" |
  jq -r '[.result[] | select(.phase == "http_request_dynamic_redirect" and .kind == "zone")][0].id // empty')
echo "redirect ruleset id (REPLACE_WITH_REDIRECT_RULESET_ID): ${redirects:-none (remove its import block)}"

if [[ -n "$redirects" ]]; then
  echo
  echo "== Redirect rules (must match cloudflare_ruleset.redirects)"
  get "/zones/$zone_id/rulesets/$redirects" |
    jq '.result | {name, rules: [.rules[] | {description, expression, action, action_parameters, enabled}]}'
fi

echo
echo "== DNS records (TXT and MX would sit next to the ones Terraform adds)"
get "/zones/$zone_id/dns_records?per_page=100" |
  jq -r '.result[] | [.type, .name, .content, (if .proxied then "proxied" else "dns only" end), (.meta.read_only // false | if . then "read-only" else "" end)] | @tsv'

echo
echo "== DNSSEC"
get "/zones/$zone_id/dnssec" | jq -r '.result.status'

echo
echo "== Zone settings changed from their defaults (modified_on is set)"
get "/zones/$zone_id/settings" |
  jq -c '.result[] | select(.modified_on != null) | {id, value, modified_on}'

echo
echo "== Web Analytics sites in the account"
get "/accounts/$CLOUDFLARE_ACCOUNT_ID/rum/site_info/list" |
  jq -c '.result[]? | {site_tag, host: (.ruleset.zone_name // .host), auto_install}'
