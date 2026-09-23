# Recorded external responses (§5.10 contract tests)

**Status: hand-authored samples, not live recordings.** The build environment could not reach
`www.trade-tariff.service.gov.uk` or `www.ecb.europa.eu`, so these files were written by hand in the
documented UK Trade Tariff API v2 (JSON:API) and HMRC/ECB file shapes. Before the contract tests
are trusted they must be re-recorded against the live endpoints (`scripts/record-fixtures.ts`,
to be written) and then re-recorded monthly per the brief.

- `tariff/commodity-9503004100.json` — toys, third-country duty 0%, VAT 20%.
- `tariff/commodity-8712003000.json` — bicycles from China: 103 + two exporter-specific 552
  anti-dumping measures + VAT.
- `tariff/commodity-1701131000.json` — raw cane sugar: specific duty per 1000 kg, VAT 0%.
- `tariff/commodity-6403999600.json` — footwear with an EU (1013) preferential measure whose
  children are listed, VAT 20%.
- `tariff/heading-9503.json` — heading listing for HS normalisation.
- `fx/hmrc-monthly-sample.csv`, `fx/ecb-daily-sample.xml`.
