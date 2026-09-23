# 0010. Sailing schedules: read-only visibility before booking

- **Status:** Proposed — aggregator choice and pricing tier are open decisions
- **Date:** 2026-09-23
- **Brief:** §1 (calculator and system of record, never the carrier), §2 (phasing), §6 (Phase 2 booking)

## Context

Micro-importers plan around sailings they cannot see: carrier schedules, transit times with or
without transshipment, and the cargo, VGM and customs-documentation cut-offs at the origin port
are normally locked inside forwarder portals. The industry now exposes this data through
aggregator APIs (Portcast, Linescape, SeaRates, Freightify) and, for the largest carriers,
through the DCSA "Commercial Schedules" standard, so one normalised shape can be fed by either.

Two facts constrain the design:

1. **Schedule visibility is not equipment availability.** An API can show when a vessel sails;
   it cannot promise that an empty container is allocated at the origin depot for the supplier.
   Only the partner forwarder's booking system confirms that.
2. **No Phase 2 code ships before the forwarder agreement is signed** (§2). Schedules do not
   book anything, so they are not Phase 2 code, but the UI wording must never imply a booking.

## Decision

- Schedules are a **read-only, Phase 1.5 capability** exposed through a `ScheduleProvider`
  adapter (`packages/adapters/src/schedules/`), built like every other external adapter:
  timeout, retry with jitter, circuit breaker, labelled fallback (`ScheduleResult.ok === false`
  with a reason; never an invented sailing).
- The normalised `Sailing` type is **DCSA-shaped** (carrier, service, vessel/voyage, legs with
  transshipment ports, ETD/ETA, transit days, cargo/VGM/customs cut-offs, blank-sailing and
  congestion signals). Aggregator adapters map into it; a direct DCSA carrier adapter later is a
  mapping, not a redesign. The first implementation is a stub that reports `NOT_CONFIGURED`.
- Schedules **never change a quote's money.** `deriveScheduleSignals(sailing, now)` produces
  advisory signals (`BLANK_SAILING_RISK`, `CUTOFF_PASSED`, `CUTOFF_IMMINENT`, `TRANSSHIPMENT`,
  `PORT_CONGESTION`). They are not engine warnings and never touch `calcVersion`; in Phase 2,
  `CUTOFF_PASSED` and a confirmed blank sailing become booking preconditions (§6.1).
- **Equipment is never asserted.** The UI action on a sailing is "Request space", not "Book".
  A shipment gains a `selectedSailing` snapshot (copied, never referenced, as with quotes) and
  its status only reaches `BOOKED` when the forwarder confirms the equipment allocation.
- **Caching:** sailings are cached per (provider, origin, destination, departure window) with a
  short TTL (hours, not days) because schedules move daily. A `SailingCache` table is added to
  the schema when the feature is built, not now.

## Consequences

- The contract exists before any aggregator agreement, so provider evaluation can be done
  against real code and recorded fixtures.
- Adds two decisions to `docs/decisions-needed.md`: which aggregator (Portcast congestion data vs
  Linescape carrier breadth), and whether schedule search is a paid-tier feature (aggregators
  bill per query, so rate limits and caching are a cost control, not only a courtesy).
- Blank-sailing and congestion signals depend on the chosen provider; the type keeps them
  optional so a provider without them does not fake a "clear" signal.
