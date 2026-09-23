# Design system and landing/dashboard layout

- **Status:** Agreed 2026-09-23. Applied as a single restyle pass after milestones M2, M3, M5,
  M6 and M9 merge (they all touch the shell and stylesheet).
- **Source:** founder's mockups for the landing page and the workspace "Command Center".
- **Rules:** plain CSS with tokens, no Tailwind; icons from `lucide-react` (inline SVG, allowed
  under the `self` CSP); no external fonts or images; every number on screen comes from data.

## Tokens (`app/styles.css` `:root`)

| Token             | Value                                                                                           | Use                                               |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `--navy-900`      | `#0f172a`                                                                                       | sidebar, hero, map panel backgrounds              |
| `--navy-800`      | `#1e293b`                                                                                       | raised dark surfaces, borders on dark             |
| `--slate-50`      | `#f8fafc`                                                                                       | page background                                   |
| `--slate-100/200` | `#f1f5f9` / `#e2e8f0`                                                                           | card borders, dividers                            |
| `--slate-500`     | `#64748b`                                                                                       | secondary text                                    |
| `--slate-900`     | `#0f172a`                                                                                       | primary text on light                             |
| `--cyan-400`      | `#22d3ee`                                                                                       | accent on dark: icons, eyebrow labels, active nav |
| `--cyan-700`      | `#0e7490`                                                                                       | accent on light: eyebrow labels                   |
| `--lime-500`      | `#c5f042`                                                                                       | primary call to action, live indicator dot        |
| `--lime-600`      | `#b0d83b`                                                                                       | call-to-action hover                              |
| `--red-600`       | `#dc2626`                                                                                       | unfavourable / missing                            |
| `--emerald-600`   | `#059669`                                                                                       | favourable / on schedule                          |
| radius            | `12px` cards, `16px` panels, `24px` hero cards, `999px` pills                                   |                                                   |
| shadow            | `0 8px 30px rgb(0 0 0 / 0.04)` light cards; `0 20px 40px rgb(0 0 0 / 0.3)` dark panels          |                                                   |
| type              | system sans; hero `3rem/1.1` extra-bold; section `2.25rem`; eyebrow `0.75rem` uppercase tracked |                                                   |

Contrast: cyan-400 on navy-900 and slate-900 on lime-500 both pass WCAG AA for normal text.

## Landing page (`/`)

- **Nav:** logo mark (box icon in navy with cyan), wordmark, menu button on mobile, links to
  Calculator and Sign in.
- **Hero (dark):** eyebrow pill "Landed cost, opened up"; headline "Know what it really costs.
  Before you commit." with the second line in cyan; body: "Harbour gives growing importers the
  fully landed cost per unit, freight, duty, VAT and fees, before they pay a supplier. Keep
  products, HS codes and documents in one workspace, and follow every shipment to the door."
  Primary button (lime) "Try the calculator" → `/calculator`; secondary "Sign in".
- **Corrected:** no "freight forwarding network", "join the network", "trusted capacity" or
  "containers available". The platform is a calculator and system of record, not a forwarder
  (brief §1).
- **Proof section (light):** eyebrow "What you get"; three cards with icons: Landed cost per
  unit (duty and VAT from the UK tariff, HMRC monthly rates), Catalogue (HS codes verified,
  reused in every quote), Tracking (real carrier milestones and vessel positions, labelled by
  source).
- **Numbers panel:** only figures the platform produces. Phase 0: lanes in the rate sheet
  (from `RateSheetFreightProvider.lanes().length`), commodities looked up, calculations
  completed (from the Phase 0 counter). Hidden until each figure is non-zero. **Corrected:** no
  TEU in motion, containers available, on-time percentage, or invented lanes.
- **Lanes list:** the rate sheet's actual lanes, e.g. "Shenzhen → Felixstowe · sea LCL · ~35
  days", with a live dot only when the rate sheet is not a placeholder.
- Footer keeps the existing disclaimer.

## Workspace shell

- **Sidebar (desktop) / top bar with menu (mobile):** navy, logo, nav items with icons: Home,
  Quotes, Tracking, Products, Documents, Settings & billing. Active item cyan on navy-800/50.
  Organisation switcher at the bottom.
- **Header:** search box (placeholder "Search POs, containers or SKUs") wired to a search
  route once M7 exists; until then it searches products and quotes. Notification bell only when
  a notifications feature exists (not yet). Avatar with the user's initials.

## Home ("Command Center", `/app`)

- Title and a lime "+ New quote" button.
- **Action required banner** (navy): existing M1 logic (EORI missing, or own deferment without
  CDS authority) with "Complete setup →" to Settings.
- **Stat cards:** Active shipments (count of shipments not DELIVERED/CANCELLED, sub-label
  "on schedule" only when provider ETA ≤ planned), Estimated landed cost (sum of READY/ACCEPTED
  quotes' `totalLandedCostExVat` this month), Missing documents (M5 missing-files count).
- **Map panel** (2 columns): the M9 map component with the "Live tracking" pill; when no
  provider is configured the pill reads "Manual milestones"; when demo mode is on it reads
  "Simulated data".
- **Recent drafts** (1 column): three most recent DRAFT quotes: lane, updated time, container
  or pallet summary, total, "Continue →".

## Components to extract

`Card`, `StatCard`, `EyebrowLabel`, `Pill` (live/manual/simulated variants), `Banner`
(navy action, amber indicative, green ready), `PrimaryButton` (lime), `SidebarNav`.
