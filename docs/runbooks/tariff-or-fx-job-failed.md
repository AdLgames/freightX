# Runbook: tariff or FX job failed

Alert sources: the worker's `fx-refresh` (HMRC monthly + ECB daily) and `tariff-refresh` queues
(BullMQ), and the "HMRC monthly FX missing by the 2nd" check.

Impact if ignored: quotes fall back to ECB rates with `FX_FALLBACK` (still `READY`), or, if
neither source has the currency, the FX stage fails and quotes become `INDICATIVE`. Tariff
refresh failures mean the 24 h `TariffCache` ages out and live lookups take the full latency
and breaker risk. Nothing mis-prices silently; see ADR-0008.

## 1. Triage (10 minutes)

1. Open the worker logs for the failed job (`<worker log query placeholder>`); note the error
   class: HTTP status, timeout, zod validation failure, or database error.
2. Check the upstream:
   - HMRC monthly rates: has this month's file been published? It usually appears about a week
     before the month starts. If it has not, the job is not broken — wait and re-check daily.
   - ECB reference rates: published on TARGET business days around 16:00 CET. No publication on
     weekends and ECB holidays is normal.
   - UK Trade Tariff API: check its status page / a manual `GET` of a known commodity.
3. If the error is a **zod validation failure**, the upstream format changed. That is a code
   change, not an ops action: open a high-priority issue, attach the raw response (no PII in
   these payloads) and use the manual seed below in the meantime.

## 2. HMRC monthly rates missing by the 2nd — manual seed

The engine reads `FxRate` rows; the worker normally writes them. Until the job succeeds:

1. Obtain the month's rates from the HMRC exchange-rates publication (download the CSV/XML
   for the month by hand).
2. Run the seed script from a trusted machine with production `DATABASE_URL` in the
   environment (never pasted into a shell history file):

   ```sh
   # Re-run the fetch inline first (no Redis needed):
   pnpm --filter @harbour/worker run once -- fx-refresh
   ```

   A dedicated `fx:seed` script (idempotent on `(source, currency, validFrom)`, taking a
   downloaded HMRC file) is not built yet. Until it exists, insert rows directly with a reviewed SQL script that sets
   `source`, `currency`, `rateToGbp` (6 dp), `validFrom`, `validTo`; keep the script in the
   incident record.

3. Verify: run a calculation in the currency concerned and confirm the quote shows
   `fxSource = HMRC_MONTHLY` for the current month and no `FX_FALLBACK` warning.
4. Re-run the job (`<queue dashboard placeholder>` → retry) once the upstream is back so the
   automated path is proven again.

## 3. ECB fallback behaviour

- While HMRC rates are missing, quotes in currencies present in the ECB feed carry
  `fxSource = "ECB"` and warning `FX_FALLBACK`. This is non-blocking; quotes can be accepted.
- The ECB publishes reference rates for USD, CNY, INR and TRY but not for BDT, PKR or VND.
  Currencies with no ECB rate have no fallback: the FX stage fails for them and the quote is
  `INDICATIVE` with the failure recorded in `warnings`. Seed those manually (section 2).
- ECB rates are quoted against EUR; the adapter derives `rateToGbp` via the EUR/GBP rate.
  If the EUR/GBP row itself is missing, every ECB-derived rate is missing — seed EUR first.

## 4. Tariff refresh failed

- `TariffCache` rows expire after 24 h; lookups then go live and are protected by the circuit
  breaker. If the API is down for long, follow `circuit-breaker-open.md`.
- Do not hand-edit `TariffCache`. If a specific commodity is urgent, the public calculator's
  manual duty/VAT entry (`TARIFF_MANUAL`, always `INDICATIVE`) is the supported workaround.

## 5. Close

Record cause, time to detect, time to fix, and whether the seed script or alerting needs
changing. If the failure was a format change, link the fix PR.
