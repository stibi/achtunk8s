# The GitHub repository stibi/achtunk8s. Created by hand and imported (imports.tf).
# Actions secrets are not managed here: their values would land in the state. They are
# listed in README.md. The social preview image has no API; set it in Settings → General.

locals {
  repository = "achtunk8s"
}

resource "github_repository" "achtunk8s" {
  name         = local.repository
  description  = "Self-hosted alert inbox for Prometheus Alertmanager with a native macOS app: alert history, unread state, search, silences and notifications instead of alerts in Teams or Slack channels."
  homepage_url = "https://achtunk8s.io"
  topics = [
    "alertmanager",
    "prometheus",
    "alerting",
    "alerts",
    "kubernetes",
    "self-hosted",
    "macos",
    "swiftui",
    "monitoring",
    "observability",
    "notifications",
    "incident-response",
    "typescript",
    "fastify",
    "postgresql",
  ]
  visibility = "public"

  has_issues      = true
  has_discussions = false
  has_projects    = false
  has_wiki        = false

  # Merge methods as set by hand. Work lands on main directly (AGENTS.md); these only
  # matter for the occasional pull request.
  allow_merge_commit          = true
  allow_squash_merge          = true
  allow_rebase_merge          = true
  allow_auto_merge            = false
  allow_update_branch         = false
  delete_branch_on_merge      = true
  merge_commit_title          = "MERGE_MESSAGE"
  merge_commit_message        = "PR_TITLE"
  squash_merge_commit_title   = "COMMIT_OR_PR_TITLE"
  squash_merge_commit_message = "COMMIT_MESSAGES"
  web_commit_signoff_required = false
  allow_forking               = true

  security_and_analysis {
    secret_scanning {
      status = "enabled"
    }
    secret_scanning_push_protection {
      status = "enabled"
    }
  }

  # Never delete the repository: a destroy archives it instead, and Terraform refuses to
  # plan a destroy at all.
  archive_on_destroy = true
  lifecycle {
    prevent_destroy = true
  }
}

# Dependabot alerts, and pull requests that fix them.
resource "github_repository_vulnerability_alerts" "achtunk8s" {
  repository = github_repository.achtunk8s.name
  enabled    = true
}

resource "github_repository_dependabot_security_updates" "achtunk8s" {
  repository = github_repository.achtunk8s.name
  enabled    = true

  # Security updates need the alerts first.
  depends_on = [github_repository_vulnerability_alerts.achtunk8s]
}

# main can't be deleted or force-pushed. Nothing else: agents and people push straight to
# main, without pull requests or reviews (AGENTS.md).
resource "github_repository_ruleset" "main" {
  repository  = github_repository.achtunk8s.name
  name        = "main"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true
  }
}

# The environment the infra workflow applies in, only from main. Add required reviewers
# here to make every apply wait for an approval.
resource "github_repository_environment" "infra" {
  repository  = github_repository.achtunk8s.name
  environment = "infra"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "infra_main" {
  repository     = github_repository.achtunk8s.name
  environment    = github_repository_environment.infra.environment
  branch_pattern = "main"
}

# The environment the release workflow publishes the macOS client in (ADR 0021), only from
# main. It holds the update signing key and the R2 keys for the updates bucket (README.md),
# so a workflow on any other branch, or from a fork, can't read them.
resource "github_repository_environment" "release" {
  repository  = github_repository.achtunk8s.name
  environment = "release"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "release_main" {
  repository     = github_repository.achtunk8s.name
  environment    = github_repository_environment.release.environment
  branch_pattern = "main"
}
