# 0017. Shipment tracking: container milestones, vessel positions, and the map

- **Status:** Proposed design. Phase 2: no tracking code ships before the forwarder agreement
  (brief §2). Schema is designed now so no later migration is forced.
- **Date:** 2026-09-23
- **Brief:** §2, §4 (`Shipment`, `ShipmentEvent`), §6.4 (webhooks and polling), §7.5 (CSP),
  §7.8 (alerts)

## Context

Two data streams make a tracking map: discrete container milestones from terminal systems (gate
in, loaded, discharged), and vessel positions from AIS. Milestones are cheap and pushed by
webhook; AIS positions are billed per call. Ocean freight moves slowly, so polling positions
like a taxi app burns credits for no user value. The design decouples the two and polls
per vessel, not per container.

## Decision

### Schema

- `Container` (tenant table): `shipmentId`, `organizationId`, `containerNumber` (ISO 6346,
  check digit validated), `sizeType` (`20GP`, `40GP`, `40HC`, `45HC` enum), `vesselImo`,
  `vesselName`, `voyageNumber`, `providerRef`, `lastMilestone`, `lastMilestoneAt`, timestamps.
  Composite FK to `(shipment_id, organization_id)`, row-level security, tenancy allow-list.
- **Changed:** milestones are stored in the existing append-only `ShipmentEvent`, not a new
  `TrackingEvent`. `ShipmentEvent` gains optional `containerId`, `locationLocode`,
  `locationName`, `latitude`, `longitude` (`Decimal(9,6)`). It already has `source`,
  `providerEventId` (idempotency), `statusAfter`, `occurredAt` and the append-only trigger, and
  it already feeds the `ShipmentStatus` state machine in §6.4. One timeline, one truth.
- `ActiveVessel` (shared, non-tenant): `imo` (PK, 7 digits with check digit), `name`,
  `lastLatitude`, `lastLongitude`, `speedKnots`, `headingDeg`, `positionAt`, `providerEtaAt`,
  `destinationLocode`, `pollState` enum (`AT_SEA`, `COASTAL`, `APPROACHING`, `DOCKED`,
  `STALE`), `nextPollAt`, `lastError`, `activeContainerCount`. Readable by the app role,
  written only by the worker. Containers reference it by `vesselImo`; one poll serves every
  organisation with cargo on that ship.
- Retention: positions and events are purged 90 days after `DELIVERED` (§7.3 minimisation).

### Milestones by webhook (push)

`POST /webhooks/tracking/:providerId`, following §6.4 exactly: HMAC signature with a
per-provider secret and constant-time compare, 256 KB limit, 5-minute replay window, enqueue
and return 200 within 2 seconds, worker upserts `ShipmentEvent` on `(source, providerEventId)`,
illegal status transitions are stored but do not change status, dead-letter queue. Providers:
Terminal49 or project44 (decision (ab)). `LOADED_ON_VESSEL` sets `Container.vesselImo` and
upserts `ActiveVessel`. `DISCHARGED_DESTINATION` or `VESSEL_ARRIVED` decrements the vessel's
active count; at zero the vessel is `DOCKED` and polling stops. The 6-hourly polling fallback in
§6.4 stays for milestones when no webhook has arrived in 24 hours.

### Positions by dynamic polling (smart pull)

**Changed:** the existing BullMQ worker (brief §3) runs this; no new job framework. A repeatable
job every hour selects `active_vessels` where `nextPollAt <= now()` and `pollState` is not
`DOCKED`, calls the AIS provider once per vessel (Spire or MarineTraffic, decision (ac)), and
sets the next poll from distance to the destination port: at sea 12–24 h, near coasts and choke
points (Suez, Malacca, the Channel) 4–6 h, within 50 nautical miles 1 h. Distance uses the
destination port's coordinates from a small UN/LOCODE table. Repeated failures mark `STALE`
and alert ops; a stale vessel is shown as "last seen", never extrapolated.

### Map and dead reckoning

- The tracking page lives on its own route so its map code loads only there. Between polls the
  browser extrapolates position from the last ping, speed and heading with `@turf/destination`.
  **Changed:** extrapolation is capped at the poll interval plus two hours; beyond that the icon
  stops and shows "last seen {time}". When a fresh ping arrives, the icon glides to it over one
  to two seconds using the layer's transition setting rather than jumping.
- Rendering: MapLibre GL with Deck.gl, or Mapbox GL if a Mapbox account is chosen (decision
  (ad)). Either way the map route gets its own CSP additions (`script-src`, `style-src`,
  `connect-src`, `img-src`, `worker-src blob:` for the tile and glyph hosts) through the
  existing per-route header mechanism; the global `default-src 'self'` policy is unchanged.
  **Changed:** any map token is read in the route loader from server config and restricted by
  URL in the provider's dashboard. Styling is plain CSS as elsewhere.
- Sidebar: the purchase orders and SKUs inside each container come from `Container →
Shipment → Quote → PurchaseOrder` (ADR-0013). ETA shown is the provider's ETA, labelled as
  such; the platform never computes its own.

## Consequences

- Adds decisions (ab) milestone provider, (ac) AIS provider and its per-call pricing, (ad)
  map rendering and tiles.
- Per-vessel polling keeps AIS spend proportional to distinct ships, not containers or users.
- Container check digits and IMO check digits are validated at input so a mistyped number
  never subscribes a stranger's container.
