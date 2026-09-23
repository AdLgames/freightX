## Summary

<!-- What changed and why. Link the issue or ADR. -->

## Definition of done (engineering brief §9)

- [ ] zod schema for every new input/output
- [ ] `organizationId` scoping present and covered by a cross-tenant negative test
- [ ] Money as `Decimal`; lint passes
- [ ] Unit tests for engine changes + golden fixtures updated; `calcVersion` bumped if formula changed
- [ ] Audit log entry for any state-changing action on quotes, docs, org settings
- [ ] No secrets, no PII in logs (checked via log snapshot test)
- [ ] Migration reviewed; rollback noted
- [ ] Feature flag for anything user-visible in Phase 2

## Migrations

| Field                                            | Value                                                       |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Migration reviewed by / rollback note            | <!-- @reviewer1 @reviewer2 / how to roll back, or "n/a" --> |
| Backup snapshot ID (destructive migrations only) | <!-- snapshot id, or "n/a" -->                              |
| `calcVersion` bumped? (engine formula changes)   | <!-- yes: 1.x → 1.y / no / n/a -->                          |

## Golden fixtures

<!-- If any file under packages/engine/fixtures/quotes changed, say who with customs experience reviewed the diff. -->

## Notes for reviewers

<!-- Risky areas, follow-ups, anything you want a second pair of eyes on. -->
