# Harbour infrastructure (Terraform)

Minimal, honest skeleton. Today it manages one thing: the **private documents bucket** on
Cloudflare R2 (brief §3, §7.4). App hosting, Postgres and Redis are still provisioned through
the platform of choice (Fly.io or Railway) until the hosting decision in the brief (§10 #3) is
final; a commented Fly provider stub is in `versions.tf`.

## Files

| File                            | Purpose                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `versions.tf`                   | Terraform/provider constraints, commented remote backend        |
| `variables.tf`                  | Inputs with validation (region restricted to UK/EU)             |
| `storage.tf`                    | R2 bucket; commented AWS S3 equivalent with public-access block |
| `outputs.tf`                    | Bucket name/endpoint for the app's secret manager               |
| `environments/*.tfvars.example` | Per-environment values (copy, fill in, do not commit)           |

## Prerequisites

- Terraform >= 1.9
- A Cloudflare API token with **Workers R2 Storage: Edit** on the target account, exported as
  `CLOUDFLARE_API_TOKEN`. It lives in the platform secret manager / CI secrets, never in a file
  in this repository.
- A state bucket created by hand, once, per account (see below).

## State

State is never committed. `.gitignore` already excludes `*.tfstate`, `*.tfstate.*`,
`.terraform/` and `.terraform.lock.hcl`.

1. Create a private bucket for state by hand (R2 bucket `harbour-tfstate`, or an S3 bucket in
   `eu-west-2` with versioning on).
2. Uncomment **one** `backend` block in `versions.tf`.
3. Initialise with the sensitive parts supplied at the command line, not in the file:

```sh
cd infra/terraform
export CLOUDFLARE_API_TOKEN='<from secret manager>'
# R2-backed state: an R2 API token for the state bucket, presented as S3 credentials
export AWS_ACCESS_KEY_ID='<r2 access key id>'
export AWS_SECRET_ACCESS_KEY='<r2 secret access key>'

terraform init \
  -backend-config="key=harbour/dev.tfstate" \
  -backend-config="endpoint=https://<account_id>.r2.cloudflarestorage.com"
```

Use one state key per environment (`harbour/dev.tfstate`, `harbour/prod.tfstate`) and one
API token per environment (brief §7.6).

## Plan and apply

```sh
cp environments/dev.tfvars.example environments/dev.tfvars   # then fill in; do not commit
terraform fmt -check
terraform validate
terraform plan  -var-file=environments/dev.tfvars
terraform apply -var-file=environments/dev.tfvars
```

`environments/*.tfvars` (without `.example`) should be added to `.gitignore` before the first
one is created; the root `.gitignore` is owned by the repo maintainers, so raise it in the PR
that adds the first real environment.

## Secrets

Terraform does not create or hold application secrets. After `apply`, copy the outputs into the
platform secret manager alongside the values it does not know:

| Secret manager key      | Source                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `STORAGE_BUCKET`        | output `documents_bucket_name`                                      |
| `STORAGE_ENDPOINT`      | output `s3_endpoint`                                                |
| `STORAGE_ACCESS_KEY_ID` | R2 API token scoped to that single bucket, created in the dashboard |
| `STORAGE_SECRET_KEY`    | as above                                                            |

## Guard-rails

- `prevent_destroy` is set on the documents bucket.
- `region` only accepts `weur`/`eeur`; `jurisdiction` defaults to `eu`.
- The bucket must never get a custom domain or public development URL. Reviewers reject any PR
  adding `cloudflare_r2_custom_domain` / `cloudflare_r2_managed_domain` for it.
- If AWS S3 is chosen instead, the commented `aws_s3_bucket_public_access_block` in
  `storage.tf` (all four flags `true`) is mandatory.

## Not verified

No `terraform` binary was available when this skeleton was written; run `terraform fmt -check`
and `terraform validate` before the first plan.
