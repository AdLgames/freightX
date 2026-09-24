import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  RBAC_MATRIX,
  ForbiddenError,
  assertCan,
  can,
  type Action,
  type Role,
} from '../src/rbac.js';

/**
 * The §7.2 table transcribed independently of src/rbac.ts (roles that have the tick). If the
 * brief changes, change both.
 */
const BRIEF: Record<Action, readonly Role[]> = {
  'quote.view': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  'quote.edit': ['OWNER', 'ADMIN', 'MEMBER'],
  'quote.accept': ['OWNER', 'ADMIN'],
  'doc.upload': ['OWNER', 'ADMIN', 'MEMBER'],
  'doc.download': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  'org.tax_ids.edit': ['OWNER', 'ADMIN'],
  'shipment.book': ['OWNER', 'ADMIN'],
  'billing.manage': ['OWNER'],
  'member.manage': ['OWNER', 'ADMIN'],
  'catalogue.edit': ['OWNER', 'ADMIN', 'MEMBER'], // M3
  // M5
  'doc.verify': ['OWNER', 'ADMIN'],
  // M2
  'org.company.confirm': ['OWNER', 'ADMIN'],
  'audit.view': ['OWNER', 'ADMIN'],
  'shipment.track': ['OWNER', 'ADMIN', 'MEMBER'], // M9 (ADR-0017): tracking is not booking
  // M7 (ADR-0013)
  'order.view': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  'order.edit': ['OWNER', 'ADMIN', 'MEMBER'],
  'order.issue': ['OWNER', 'ADMIN'],
};

describe('rbac matrix', () => {
  it('covers exactly the actions and roles of the brief', () => {
    expect(Object.keys(RBAC_MATRIX).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(BRIEF).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      expect(Object.keys(RBAC_MATRIX[action]).sort()).toEqual([...ROLES].sort());
    }
  });

  for (const action of ACTIONS) {
    for (const role of ROLES) {
      const expected = BRIEF[action].includes(role);
      it(`${role} ${expected ? 'can' : 'cannot'} ${action}`, () => {
        expect(can(role, action)).toBe(expected);
        if (expected) {
          expect(() => assertCan(role, action)).not.toThrow();
        } else {
          expect(() => assertCan(role, action)).toThrow(ForbiddenError);
        }
      });
    }
  }

  it('OWNER can do everything', () => {
    expect(ACTIONS.every((a) => can('OWNER', a))).toBe(true);
  });

  it('VIEWER is read-only', () => {
    const allowed = ACTIONS.filter((a) => can('VIEWER', a));
    expect(allowed).toEqual(['quote.view', 'doc.download', 'order.view']); // M7: order.view
  });

  it('fails closed on unknown roles or actions', () => {
    expect(can('SUPERUSER' as Role, 'quote.view')).toBe(false);
    expect(can('OWNER', 'db.drop' as Action)).toBe(false);
    expect(can(undefined as unknown as Role, 'quote.view')).toBe(false);
  });

  it('ForbiddenError names the role and action', () => {
    const err = new ForbiddenError('VIEWER', 'quote.edit');
    expect(err.name).toBe('ForbiddenError');
    expect(err.role).toBe('VIEWER');
    expect(err.action).toBe('quote.edit');
    expect(err.message).toContain('VIEWER');
    expect(err.message).toContain('quote.edit');
  });
});
