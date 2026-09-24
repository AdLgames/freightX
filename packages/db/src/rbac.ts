/**
 * RBAC matrix (§7.2), as data. Pure module: no Prisma import, so it typechecks and tests without
 * the generated client. `Role` mirrors the Prisma `Role` enum values exactly.
 */

export const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'quote.view',
  'quote.edit', // create/edit quotes
  'quote.accept',
  'doc.upload',
  'doc.download',
  'org.tax_ids.edit', // EORI / VAT number
  'shipment.book',
  'billing.manage',
  'member.manage',
  'shipment.track', // M9: track a container / add a manual milestone (not booking — that stays gated)
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The §7.2 table, verbatim. Row = action, column = role. Change this table and the matching row
 * in the brief together; test/rbac.test.ts asserts every cell.
 */
export const RBAC_MATRIX: Readonly<Record<Action, Readonly<Record<Role, boolean>>>> = {
  'quote.view': { OWNER: true, ADMIN: true, MEMBER: true, VIEWER: true },
  'quote.edit': { OWNER: true, ADMIN: true, MEMBER: true, VIEWER: false },
  'quote.accept': { OWNER: true, ADMIN: true, MEMBER: false, VIEWER: false },
  'doc.upload': { OWNER: true, ADMIN: true, MEMBER: true, VIEWER: false },
  'doc.download': { OWNER: true, ADMIN: true, MEMBER: true, VIEWER: true },
  'org.tax_ids.edit': { OWNER: true, ADMIN: true, MEMBER: false, VIEWER: false },
  'shipment.book': { OWNER: true, ADMIN: true, MEMBER: false, VIEWER: false },
  'billing.manage': { OWNER: true, ADMIN: false, MEMBER: false, VIEWER: false },
  'member.manage': { OWNER: true, ADMIN: true, MEMBER: false, VIEWER: false },
  'shipment.track': { OWNER: true, ADMIN: true, MEMBER: true, VIEWER: false }, // M9
};

export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  constructor(
    readonly role: Role,
    readonly action: Action,
  ) {
    super(`role ${role} may not perform ${action}`);
  }
}

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

export const isAction = (value: unknown): value is Action =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);

/** Single source of truth for authorisation decisions. Unknown role/action → false (fail closed). */
export function can(role: Role, action: Action): boolean {
  if (!isRole(role) || !isAction(action)) return false;
  return RBAC_MATRIX[action][role] === true;
}

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) throw new ForbiddenError(role, action);
}
