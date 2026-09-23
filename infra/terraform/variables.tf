variable "environment" {
  description = "Deployment environment. Drives resource naming; credentials are separate per environment (brief §7.6)."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket. Not a secret, but environment-specific."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hex string."
  }
}

variable "bucket_name" {
  description = "Base name for the private documents bucket. The environment and a short random suffix are appended."
  type        = string
  default     = "harbour-documents"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be lowercase letters, digits and hyphens (3–42 characters)."
  }
}

variable "region" {
  description = <<-EOT
    R2 location hint. Default "weur" (Western Europe) keeps customer documents in the UK/EU
    per the hosting-region decision in the brief (§10 #3: UK/EU only, recommended for GDPR
    simplicity). Allowed: weur, eeur. Other R2 regions are deliberately rejected.
  EOT
  type        = string
  default     = "weur"

  validation {
    condition     = contains(["weur", "eeur"], var.region)
    error_message = "region must be weur or eeur — customer data must stay in the UK/EU (brief §10 #3)."
  }
}

variable "jurisdiction" {
  description = <<-EOT
    R2 jurisdiction. "eu" makes Cloudflare guarantee the data never leaves the EU (a location
    hint alone is best-effort). Note the UK is not in the EU jurisdiction; if the founder decides
    on UK-only residency this bucket must move to a UK-region provider (e.g. AWS eu-west-2).
  EOT
  type        = string
  default     = "eu"

  validation {
    condition     = contains(["default", "eu"], var.jurisdiction)
    error_message = "jurisdiction must be default or eu."
  }
}

variable "tags" {
  description = "Free-form labels recorded in outputs for cross-referencing with the platform dashboard."
  type        = map(string)
  default     = {}
}
