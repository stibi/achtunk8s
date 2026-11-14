output "zone_id" {
  description = "The achtunk8s.io zone."
  value       = local.zone_id
}

output "dnssec_ds_record" {
  description = "The DS record to add at the registrar, once, after DNSSEC is turned on."
  value       = cloudflare_zone_dnssec.site.ds
}

output "web_analytics_site_tag" {
  description = "The Web Analytics site, for the dashboard and a manual beacon if automatic setup can't inject it."
  value       = cloudflare_web_analytics_site.site.site_tag
}
