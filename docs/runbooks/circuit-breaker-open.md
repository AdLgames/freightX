# Runbook: circuit breaker open for more than 10 minutes

Breakers (opossum) wrap every external call: SeaRates (Phase 1), UK Trade Tariff API, HMRC and
ECB FX fetches, forwarder APIs (Phase 2). Each opens after 5 failures in 60 s and probes every
30 s in half-open state (brief §5.8). A breaker open for more than 10 minutes means the
upstream is genuinely unavailable or we are being rejected.

## What the user sees while it is open

| Breaker       | Degradation                                                                        | Quote status                         |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------ |
| SeaRates      | Rate sheet used, `FREIGHT_FALLBACK`; no rate-sheet lane → `FREIGHT_UNAVAILABLE`    | `READY` / `INDICATIVE` (ADR-0007)    |
| Tariff API    | Cached measures (≤ 24 h) used; cache miss → HS cannot be verified, `HS_UNVERIFIED` | `INDICATIVE` on cache miss           |
| HMRC / ECB FX | Nothing in the request path changes (rates are read from the store); jobs fail     | unchanged (see tariff-or-fx runbook) |
| Forwarder     | Bookings sit in `PENDING_BOOKING` via the outbox; polling paused                   | n/a                                  |

None of these mis-price. The risk is customer frustration and, for the tariff API, a growing
share of `INDICATIVE` quotes.

## 1. Confirm it is the upstream, not us

1. Look at the breaker metrics (`<dashboard placeholder>`): failure reason distribution.
   - Timeouts / 5xx / connection refused → upstream outage. Go to step 2.
   - 401/403 → our credential was revoked or rotated. Check the secret manager for a recent
     change; re-issue the key; restart the worker. Treat an unexplained revocation as a security
     incident.
   - 429 → we are rate-limited. Check for a runaway job or a public-calculator abuse pattern
     (per-IP limit and Turnstile stats). Reduce concurrency in the worker config.
   - zod validation failures counted as errors → upstream format change. Code fix required;
     open a high-priority issue.
2. Check the upstream status page and try one manual request from outside our network.

## 2. While it stays open

- Do **not** raise the failure threshold or disable the breaker to "get quotes through".
- SeaRates: confirm the rate-sheet version in use is current (`packages/adapters` rate sheet,
  `rateSource = RATE_SHEET_Vn`). If it is older than a fortnight, refresh it via the normal
  PR path; the fallback is only as good as the sheet.
- Tariff API: if the outage will exceed the cache TTL, warm the cache for the top commodities
  as soon as half-open probes succeed (`pnpm --filter @harbour/worker run tariff:warm`, or the
  equivalent queue job). Consider temporarily extending `TariffCache` TTL via config (not
  code) if the API is known to be down for a planned period.
- Forwarder: the outbox retries automatically; watch DLQ depth. Do not replay DLQ jobs while
  the breaker is open.

## 3. Recovery

- The breaker closes itself after a successful half-open probe. Confirm the failure rate drops
  to zero and latency is normal.
- Re-run any jobs that failed during the window (queue dashboard → retry failed).
- If quotes were produced on fallback data for more than an hour, note the window in the
  incident record; support may need it when customers query a quote.

## 4. Close

Record duration, cause, and whether the fallback behaved as designed. If a breaker opens more
than twice a month for the same upstream, raise the question of a second provider.
