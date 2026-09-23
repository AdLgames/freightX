# Freight rate sheets (§5.8)

Versioned JSON rate sheets are the Phase 0 freight source and the Phase 1 fallback/benchmark.

- `v1.json` — **placeholder figures** (`"placeholder": true`). They are shaped like real lane rates
  so the calculator works end to end, but they have not been sourced from the Freightos Baltic
  Index or forwarder quotes. Do not launch publicly on placeholder figures.
- Refresh fortnightly. Every change is a new file (`v2.json`, …) and a new `version` string; the
  engine records `rateSource = "RATE_SHEET_Vn"` on each quote, so old quotes stay explainable.
- Schema: `rateSheetSchema` in `src/freight/rate-sheet.ts` (validated on load).
- Lanes: Shanghai / Ningbo / Shenzhen / Nhava Sheva / Istanbul → Felixstowe / Southampton /
  London Gateway (LCL + FCL); Shanghai Pudong / Shenzhen / Mumbai / Istanbul → Heathrow (air).
