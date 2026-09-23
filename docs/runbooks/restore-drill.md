# Runbook: quarterly restore drill

Brief §7.3: daily encrypted snapshots, 30-day retention, quarterly restore drill. A backup
that has never been restored is a hope, not a backup. This drill is also the procedure to
follow for a real restore, minus the "throw it away" steps.

Schedule: first working week of January, April, July, October. Owner: `<drill owner
placeholder>`. Result recorded in `<drill log placeholder>`.

## Scope

1. Postgres (managed by the platform: `<provider placeholder>`).
2. Documents bucket (R2/S3) — object listing and a sample of objects.
3. Redis is not restored; sessions and queues are rebuilt (users sign in again, jobs are
   idempotent).
4. Secrets: confirm the secret manager can be read by a fresh deploy (no restore needed, but
   the drill proves access).

## Procedure

1. **Pick the snapshot.** Choose yesterday's daily snapshot. Record its ID and timestamp.
2. **Restore Postgres into an isolated instance** (never over production):
   - Create a new database from the snapshot in the same region (UK/EU only).
   - Point a scratch copy of the app (`<staging environment placeholder>`) at it with a
     read-only role. Do not connect production workers to it.
3. **Verify the database.**
   - `pnpm --filter @harbour/db exec prisma migrate status` reports no pending migrations.
   - Row counts for `Organization`, `Quote`, `QuoteLine`, `Document`, `AuditLog` are within
     the expected range of production's counts at the snapshot time.
   - RLS is still forced: as the app role with `app.current_org` set to org A, selecting from
     `Quote` returns only org A's rows.
   - Pick three `ACCEPTED` quotes and confirm their totals equal the sum of their lines.
   - Confirm `eoriNumber`/`vatNumber` are still ciphertext at rest and decrypt correctly with
     the current KMS key version.
4. **Verify documents.** For ten `Document` rows from the restored database, confirm the
   object exists at `storageKey` in the bucket and its `sha256` matches. Confirm that a
   presigned GET works and expires.
5. **Measure.** Record time from "decision to restore" to "verified": this is our real RTO.
   Record the snapshot age: this is our real RPO.
6. **Tear down** the restored instance and the scratch app. Confirm nothing from the drill
   was left connected to a production credential.
7. **Write it up** in the drill log: snapshot ID, RTO, RPO, anything that failed, actions
   with owners. Failures are fixed within the quarter.

## If this is a real restore

- Declare an incident first (`README.md` in this directory) and freeze writes (put the app in
  maintenance mode) before restoring.
- Restore into a new instance, verify as above, then switch the app's `DATABASE_URL` in the
  secret manager and redeploy. Keep the damaged instance for forensics.
- Communicate the data-loss window (RPO) to affected organisations honestly.
