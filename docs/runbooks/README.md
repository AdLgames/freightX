# Runbooks

Operational procedures for Harbour. Each runbook is short, ordered and assumes the reader is
on call at 3 a.m. Values that depend on the deployment (dashboards, hostnames, contacts) are
shown as `<placeholder>` and must be filled in when the environment exists.

## Index

| Runbook                                                  | Trigger                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| [security-incident.md](security-incident.md)             | Suspected breach, leaked secret, cross-tenant access      |
| [tariff-or-fx-job-failed.md](tariff-or-fx-job-failed.md) | HMRC/ECB/tariff job alert, FX missing by the 2nd          |
| [circuit-breaker-open.md](circuit-breaker-open.md)       | SeaRates/tariff/FX breaker open for more than 10 minutes  |
| [restore-drill.md](restore-drill.md)                     | Quarterly (scheduled), and after any backup config change |
| [production-env.md](production-env.md)                   | Standing up or changing a production environment; launch  |

## On-call expectations (brief §7.8)

Until there are paying customers there is no formal rota; the founder and the lead engineer
share alerts. From the first paying org, a PagerDuty/OpsGenie rota is set up and the alerts
below page.

| Alert                              | Source        | Page? | First action                                                    |
| ---------------------------------- | ------------- | ----- | --------------------------------------------------------------- |
| Error rate > 1% over 5 min         | Sentry / OTel | Yes   | Check latest deploy; roll back if it correlates                 |
| p95 latency > 2 s                  | OTel          | Yes   | Check Postgres/Redis health, then breaker state                 |
| Tariff or FX job failed            | Worker        | Yes   | [tariff-or-fx-job-failed.md](tariff-or-fx-job-failed.md)        |
| Circuit breaker open > 10 min      | Worker / app  | Yes   | [circuit-breaker-open.md](circuit-breaker-open.md)              |
| Dead-letter queue depth > 0        | Worker        | Yes   | Inspect DLQ job; fix or discard with a note; never replay blind |
| Failed login spike                 | App           | Yes   | Treat as security incident until shown otherwise                |
| Presigned URL generation spike     | App           | Yes   | Treat as security incident until shown otherwise                |
| HMRC monthly FX missing by the 2nd | Worker        | Yes   | [tariff-or-fx-job-failed.md](tariff-or-fx-job-failed.md)        |

Response targets: acknowledge within 15 minutes, first update within 30 minutes, then hourly
until resolved. Every page gets a post-incident note in `<incident tracker placeholder>` within
two working days: what happened, impact, what changes.

## Conventions

- Never run `prisma db push` or hand-edit data in production during an incident; use a
  reviewed migration or a scripted, logged, idempotent job.
- Every action taken during an incident is written down with a timestamp as it happens.
- If in doubt whether something is a security incident, it is; start
  [security-incident.md](security-incident.md).
