# Runbook: security incident

Use for: leaked secret or credential, suspected cross-tenant data access, compromised user or
staff account, malicious upload that passed scanning, unexpected data export, failed-login or
presigned-URL spikes that are not explained within 15 minutes.

Incident lead: the first responder until handed over explicitly. Record every step with a
timestamp in `<incident tracker placeholder>` as you go.

## 1. Contain (first 30 minutes)

1. **Freeze the blast radius.**
   - Switch the `booking.enabled` feature flag off for all orgs if Phase 2 is live.
   - If a specific org or user is affected, suspend their sessions first (step 2).
2. **Revoke sessions.** Sessions live in Redis (brief §7.1).
   - Single user: delete that user's session keys, then rotate their memberships' role if
     escalation is suspected.
   - Everyone: flush the session keyspace (`<redis session prefix placeholder>`). All users are
     logged out; magic links continue to work.
3. **Rotate secrets** in the platform secret manager, in this order, redeploying after each
   batch: session signing secret; envelope-encryption KMS key (create a new key version, do not
   delete the old one until re-encryption completes); Stripe restricted key and webhook secret;
   storage (R2/S3) API token; forwarder webhook secrets; database and Redis passwords; any
   CI/deploy tokens. Record old key IDs and rotation times.
4. **Cut off the vector.** Block the offending IP range at the platform edge, disable the
   compromised account, or pull the malicious object from storage (keep a copy in the evidence
   bucket first, step 5).
5. **Preserve evidence** before anything is cleaned up: export relevant `AuditLog` rows,
   application logs and access logs for the window; copy affected storage objects to
   `<evidence bucket placeholder>` with restricted access; take a database snapshot and note
   its ID. Do not modify evidence; work on copies.

## 2. Assess (first 4 hours)

- Establish scope: which organisations, which data classes (EORI/VAT numbers, documents,
  quotes, emails), first and last timestamp of the activity. `AuditLog` is the primary source;
  storage access logs are the second.
- Classify: personal data involved → GDPR personal-data breach; assess the risk to
  individuals. Involve `<data protection contact placeholder>` and legal counsel.
- Decide whether to take the service down. Bias toward availability only if you can prove the
  vector is closed.

## 3. Notify

- **Affected organisations within 72 hours** of becoming aware (GDPR Art. 33/34; brief §7.8).
  Use the template below; send from `<security contact email placeholder>`; log each send in
  the incident record.
- ICO notification within 72 hours where the breach is likely to result in a risk to
  individuals. Counsel confirms.
- Forwarder or payment partners if their credentials or data are involved.

### Customer notification template

```
Subject: Security notice for your Harbour account — action <required / not required>

On <date> we identified <one-sentence description of what happened>.

What was affected: <data classes and time window, for this organisation specifically>.
What was not affected: <e.g. no documents were accessed; no payment details are stored>.

What we have done: <containment steps in plain language, e.g. all sessions were signed out,
credentials were rotated, the issue was fixed on <date>>.

What you should do: <e.g. nothing; sign in again; review the members list; contact your
forwarder if a document reference was exposed>.

We will send a further update by <date>. You can reach us at <security contact email
placeholder>. We are sorry this happened.
```

## 4. Recover

- Deploy the fix with a PR that references the incident record; expedite review but do not
  skip it.
- Re-encrypt data under the new key version and retire the old one.
- Watch the failed-login, presigned-URL and error-rate alerts for 48 hours.
- Lift the booking kill switch once the fix is confirmed.

## 5. Learn

Post-incident review within five working days: timeline, root cause, what detected it, what
should have detected it earlier, concrete changes with owners. Add tests for the vector
(cross-tenant negative test, log snapshot test, etc.) in the same sprint.
