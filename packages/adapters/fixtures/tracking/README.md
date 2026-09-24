# Tracking provider fixtures (M9, ADR-0017)

**Status: hand-authored samples, not live recordings.** The build environment could not reach
Terminal49, Spire or MarineTraffic (no credentials, no sandbox), so every file here was written by
hand in the shape their public documentation describes. They exercise the adapters' parsing and
signature checks; they are **not evidence** that the parsers match the live APIs. Re-record each
against a sandbox before the provider is enabled (docs/decisions-needed.md (ae)).

- `terminal49-webhook-vessel-loaded.json` — a `webhook_notification` for
  `container.transport.vessel_loaded` with the transport event, container, vessel and port in
  `included` (JSON:API). Signed in tests with the test secret.
- `terminal49-webhook-vessel-discharged.json` — the matching discharge at the destination.
- `terminal49-tracking-request.json` — response to `POST /v2/tracking_requests`.
- `spire-vessels.json` — GraphQL `vessels(imo: [...])` response with two vessels.
- `marinetraffic-exportvessel.json` — `exportvessel ... protocol:jsono` single-vessel rows.

Container numbers (`CSQU3054383`, `MSKU1234565`) and IMO numbers (`9074729`, `9362994`) satisfy
their check digits; nothing here refers to a real shipment.
