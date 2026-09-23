# Private document storage (brief §3, §7.4).
#
# Documents are uploaded via presigned PUT and read via short-lived presigned GET only. The
# bucket must never be publicly readable.
#
# Why there is no "block public access" resource for R2:
#   R2 buckets have no ACLs and are private by default. A bucket becomes readable on the
#   internet only if someone enables "Public Development URL" (r2.dev) or attaches a custom
#   domain to it. Neither is done here, and reviewers must reject any PR that adds a
#   `cloudflare_r2_custom_domain` or `cloudflare_r2_managed_domain` resource for this bucket.
#   Access is granted exclusively through an R2 API token (S3-compatible) scoped to this bucket,
#   held in the platform secret manager, and used by the app to sign URLs.

resource "random_id" "bucket_suffix" {
  byte_length = 2

  keepers = {
    environment = var.environment
  }
}

locals {
  bucket_name = "${var.bucket_name}-${var.environment}-${random_id.bucket_suffix.hex}"
}

resource "cloudflare_r2_bucket" "documents" {
  account_id   = var.cloudflare_account_id
  name         = local.bucket_name
  location     = var.region
  jurisdiction = var.jurisdiction

  lifecycle {
    # Destroying the bucket destroys customer documents. Deletion must be a deliberate,
    # reviewed change (remove this block in the same PR that removes the bucket).
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Alternative: AWS S3 (eu-west-2, London) if the hosting decision lands on AWS.
# Keep all four public-access flags true; presigned URLs continue to work with them set.
# ---------------------------------------------------------------------------
# resource "aws_s3_bucket" "documents" {
#   bucket = local.bucket_name
# }
#
# resource "aws_s3_bucket_public_access_block" "documents" {
#   bucket                  = aws_s3_bucket.documents.id
#   block_public_acls       = true
#   block_public_policy     = true
#   ignore_public_acls      = true
#   restrict_public_buckets = true
# }
#
# resource "aws_s3_bucket_ownership_controls" "documents" {
#   bucket = aws_s3_bucket.documents.id
#   rule {
#     object_ownership = "BucketOwnerEnforced"   # disables ACLs entirely
#   }
# }
#
# resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
#   bucket = aws_s3_bucket.documents.id
#   rule {
#     apply_server_side_encryption_by_default {
#       sse_algorithm     = "aws:kms"
#       kms_master_key_id = var.documents_kms_key_arn   # envelope encryption per §7.3
#     }
#   }
# }
#
# resource "aws_s3_bucket_versioning" "documents" {
#   bucket = aws_s3_bucket.documents.id
#   versioning_configuration {
#     status = "Enabled"
#   }
# }
