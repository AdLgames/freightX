import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  addItemSchema,
  canTransition,
  dateToShipMonth,
  orderFormSchema,
  paidDateSchema,
  parseOrderForm,
  readOrderForm,
  shipMonthToDate,
} from './order';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';

const valid = {
  supplierId: S1,
  pickupLocationId: '',
  currency: 'USD',
  incoterm: 'FOB',
  expectedShipMonth: '2026-11',
  notes: '',
  poNumber: '',
  items: [{ productId: P1, quantity: '500', unitCost: '4.5' }],
};

describe('orderFormSchema', () => {
  it('accepts a valid order and keeps money as strings', () => {
    const r = orderFormSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.items[0]).toEqual({ productId: P1, quantity: 500, unitCost: '4.5' });
    expect(r.data.expectedShipMonth).toBe('2026-11');
    expect(r.data.pickupLocationId).toBeUndefined();
    expect(r.data.poNumber).toBeUndefined();
  });

  it('needs a supplier, a currency from the allow-list and at least one line', () => {
    expect(orderFormSchema.safeParse({ ...valid, supplierId: '' }).success).toBe(false);
    expect(orderFormSchema.safeParse({ ...valid, currency: 'XXX' }).success).toBe(false);
    const none = orderFormSchema.safeParse({ ...valid, items: [] });
    expect(none.success).toBe(false);
    if (!none.success) {
      expect(none.error.issues[0]?.message).toContain('Add at least one product');
    }
  });

  it('rejects duplicate products, bad quantities and unit costs with more than 4 dp', () => {
    const dup = orderFormSchema.safeParse({
      ...valid,
      items: [
        { productId: P1, quantity: '1', unitCost: '1' },
        { productId: P1, quantity: '2', unitCost: '1' },
      ],
    });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.error.issues[0]?.path).toEqual(['items', 1, 'productId']);
    expect(
      orderFormSchema.safeParse({
        ...valid,
        items: [{ productId: P1, quantity: '0', unitCost: '1' }],
      }).success,
    ).toBe(false);
    expect(
      orderFormSchema.safeParse({
        ...valid,
        items: [{ productId: P1, quantity: '1', unitCost: '1.00001' }],
      }).success,
    ).toBe(false);
    expect(
      orderFormSchema.safeParse({
        ...valid,
        items: [{ productId: P1, quantity: '1', unitCost: '-1' }],
      }).success,
    ).toBe(false);
  });

  it('validates the ship month and an optional PO number', () => {
    expect(orderFormSchema.safeParse({ ...valid, expectedShipMonth: '2026-13' }).success).toBe(
      false,
    );
    expect(orderFormSchema.safeParse({ ...valid, expectedShipMonth: 'Nov 2026' }).success).toBe(
      false,
    );
    const renumber = orderFormSchema.safeParse({ ...valid, poNumber: 'po-2026-007' });
    expect(renumber.success).toBe(true);
    if (renumber.success) expect(renumber.data.poNumber).toBe('PO-2026-007');
    expect(orderFormSchema.safeParse({ ...valid, poNumber: '7' }).success).toBe(false);
  });

  it('refuses HTML in notes', () => {
    expect(orderFormSchema.safeParse({ ...valid, notes: '<b>x</b>' }).success).toBe(false);
  });
});

describe('readOrderForm / parseOrderForm', () => {
  it('reads the flat form into ordered items and maps errors to input names', () => {
    const form = new FormData();
    form.set('supplierId', S1);
    form.set('currency', 'USD');
    form.set('incoterm', 'FOB');
    form.set('item_0_productId', P1);
    form.set('item_0_quantity', '500');
    form.set('item_0_unitCost', '4.5');
    form.set('item_2_productId', P2);
    form.set('item_2_quantity', 'x');
    form.set('item_2_unitCost', '1');
    const values = readOrderForm(form);
    expect(values.items).toHaveLength(2);
    expect(values.items[1]?.productId).toBe(P2);
    const parsed = parseOrderForm(values);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.errors)).toEqual(['item_1_quantity']);
  });

  it('parses a complete form', () => {
    const form = new FormData();
    form.set('supplierId', S1);
    form.set('currency', 'CNY');
    form.set('incoterm', 'EXW');
    form.set('item_0_productId', P1);
    form.set('item_0_quantity', '12');
    form.set('item_0_unitCost', '0.25');
    const parsed = parseOrderForm(readOrderForm(form));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.items[0]?.unitCost).toBe('0.25');
  });
});

describe('addItemSchema', () => {
  it('needs a product id and a positive whole quantity', () => {
    expect(addItemSchema.safeParse({ addProductId: P1, addQuantity: '3' }).success).toBe(true);
    expect(addItemSchema.safeParse({ addProductId: 'nope', addQuantity: '3' }).success).toBe(false);
    expect(addItemSchema.safeParse({ addProductId: P1, addQuantity: '1.5' }).success).toBe(false);
  });
});

describe('transitions (ADR-0013)', () => {
  it('follows the table and never leaves CLOSED or CANCELLED', () => {
    expect(canTransition('DRAFT', 'ISSUED')).toBe(true);
    expect(canTransition('ISSUED', 'IN_PRODUCTION')).toBe(true);
    expect(canTransition('ISSUED', 'READY_TO_SHIP')).toBe(true); // production may be skipped
    expect(canTransition('IN_PRODUCTION', 'READY_TO_SHIP')).toBe(true);
    expect(canTransition('READY_TO_SHIP', 'SHIPPED')).toBe(true);
    expect(canTransition('SHIPPED', 'CLOSED')).toBe(true);
    expect(canTransition('DRAFT', 'IN_PRODUCTION')).toBe(false);
    expect(canTransition('ISSUED', 'SHIPPED')).toBe(false);
    expect(canTransition('SHIPPED', 'ISSUED')).toBe(false);
    expect(canTransition('ISSUED', 'DRAFT')).toBe(false);
    for (const s of ORDER_STATUSES) {
      expect(canTransition(s, 'CANCELLED')).toBe(s !== 'CLOSED' && s !== 'CANCELLED');
    }
    expect(ORDER_TRANSITIONS.CLOSED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });
});

describe('dates', () => {
  it('ship month round-trips as the first of the month, UTC', () => {
    const d = shipMonthToDate('2026-11');
    expect(d.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(dateToShipMonth(d)).toBe('2026-11');
    expect(() => shipMonthToDate('2026-1')).toThrow(RangeError);
  });

  it('paid dates are real calendar dates', () => {
    expect(paidDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(paidDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(paidDateSchema.safeParse('1999-12-31').success).toBe(false);
    expect(paidDateSchema.safeParse('24/09/2026').success).toBe(false);
  });
});
