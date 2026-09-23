output "documents_bucket_name" {
  description = "Name of the private documents bucket. Set as STORAGE_BUCKET in the app's secret manager."
  value       = cloudflare_r2_bucket.documents.name
}

output "documents_bucket_location" {
  description = "R2 location hint the bucket was created with."
  value       = cloudflare_r2_bucket.documents.location
}

output "documents_bucket_jurisdiction" {
  description = "R2 jurisdiction the bucket was created with."
  value       = cloudflare_r2_bucket.documents.jurisdiction
}

output "s3_endpoint" {
  description = "S3-compatible endpoint for the app's storage client (STORAGE_ENDPOINT). Credentials come from an R2 API token stored in the secret manager, never from Terraform outputs."
  value       = var.jurisdiction == "eu" ? "https://${var.cloudflare_account_id}.eu.r2.cloudflarestorage.com" : "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "environment" {
  description = "Environment this state belongs to."
  value       = var.environment
}

output "tags" {
  description = "Labels passed in, echoed for cross-referencing."
  value       = var.tags
}
