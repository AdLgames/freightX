# Harbour infrastructure — provider and Terraform version constraints.
#
# Only the object-storage layer is managed here today (brief §3: S3-compatible bucket, private,
# presigned URLs only). App hosting (Fly.io or Railway), managed Postgres and managed Redis are
# provisioned through their platforms' own tooling until the hosting decision (§10 #3) is final.

terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }

    # Optional: Fly.io. The provider is community-maintained and its API surface changes;
    # enable it only once the hosting decision is made and the version has been reviewed.
    # fly = {
    #   source  = "fly-apps/fly"
    #   version = "~> 0.1"
    # }
  }

  # ---------------------------------------------------------------------------
  # Remote state — REQUIRED before anything is applied outside a laptop.
  # State contains resource IDs and may contain sensitive values; it must never be committed
  # (.gitignore already excludes *.tfstate and .terraform/). Uncomment exactly one backend and
  # supply the bucket/credentials via environment variables or `terraform init -backend-config`,
  # never via values committed to git. See README.md in this directory.
  #
  # Option A — Cloudflare R2 via the S3-compatible backend:
  # backend "s3" {
  #   bucket                      = "harbour-tfstate"            # create by hand, once, private
  #   key                         = "harbour/<environment>.tfstate"
  #   region                      = "auto"
  #   endpoint                    = "https://<account_id>.r2.cloudflarestorage.com"
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  #   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY = an R2 API token scoped to the state bucket.
  # }
  #
  # Option B — AWS S3 with locking:
  # backend "s3" {
  #   bucket       = "harbour-tfstate"
  #   key          = "harbour/<environment>.tfstate"
  #   region       = "eu-west-2"                                # London: UK-only hosting (§10 #3)
  #   encrypt      = true
  #   use_lockfile = true                                       # S3-native locking (Terraform >= 1.10)
  # }
  # ---------------------------------------------------------------------------
}

# Authentication: the Cloudflare provider reads CLOUDFLARE_API_TOKEN from the environment.
# The token lives in the platform secret manager / CI secrets, never in a tfvars file.
provider "cloudflare" {}

provider "random" {}
