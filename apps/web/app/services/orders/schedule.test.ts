import { describe, expect, it } from 'vitest';
import { formatPoNumber, orderTotals, paymentSchedule, paymentsDue } from './schedule';

const ISSUED = new Date('2026-09-24T10:00:00Z');

describe('orderTotals', () => {
  it('rounds each line to 2 dp half-up and sums exactly', () => {
    const t = orderTotals([
      { quantity: 500, unitCost: '4.5' },
      { quantity: 3, unitCost: '0.3333' },
      { quantity: 1, unitCost: '0.005' },
    ]);
    expect(t.lines.map((l) => l.lineTotal)).toEqual(['2250.00', '1.00', '0.01']);
    expect(t.totalGoodsValue).toBe('2251.01');
  });

  it('is 0.00 for no lines', () => {
    expect(orderTotals([]).totalGoodsValue).toBe('0.00');
  });

  it('never goes through floating point', () => {
    const t = orderTotals([{ quantity: 3, unitCost: '0.1' }]);
    expect(t.totalGoodsValue).toBe('0.30');
  });
});

describe('paymentSchedule (ADR-0013)', () => {
  it('PREPAID: the whole amount is the deposit, due on issue', () => {
    const s = paymentSchedule(
      '2250.00',
      {
        termType: 'PREPAID',
        depositPct: null,
        balanceTrigger: null,
        netDays: null,
      },
      ISSUED,
    );
    expect(s).toEqual({
      depositPct: '100.00',
      depositAmount: '2250.00',
      depositDueAt: ISSUED,
      balanceAmount: '0.00',
      balanceTrigger: null,
      balanceDueAt: null,
    });
  });

  it('NET: no deposit, the balance is due issuedAt + netDays', () => {
    const s = paymentSchedule(
      '2250.00',
      {
        termType: 'NET',
        depositPct: null,
        balanceTrigger: null,
        netDays: 30,
      },
      ISSUED,
    );
    expect(s.depositPct).toBe('0.00');
    expect(s.depositAmount).toBe('0.00');
    expect(s.depositDueAt).toBeNull();
    expect(s.balanceAmount).toBe('2250.00');
    expect(s.balanceDueAt?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
  });

  it('DEPOSIT_BALANCE: deposit = round2(total × pct), balance is the remainder, trigger copied', () => {
    const s = paymentSchedule(
      '2250.00',
      {
        termType: 'DEPOSIT_BALANCE',
        depositPct: '30.00',
        balanceTrigger: 'AGAINST_BILL_OF_LADING',
        netDays: null,
      },
      ISSUED,
    );
    expect(s.depositPct).toBe('30.00');
    expect(s.depositAmount).toBe('675.00');
    expect(s.depositDueAt).toBe(ISSUED);
    expect(s.balanceAmount).toBe('1575.00');
    expect(s.balanceTrigger).toBe('AGAINST_BILL_OF_LADING');
    expect(s.balanceDueAt).toBeNull();
  });

  it('DEPOSIT_BALANCE: deposit and balance always add up to the total to the penny', () => {
    const s = paymentSchedule(
      '100.01',
      {
        termType: 'DEPOSIT_BALANCE',
        depositPct: '33.33',
        balanceTrigger: 'ON_SHIPMENT',
        netDays: null,
      },
      ISSUED,
    );
    expect(s.depositAmount).toBe('33.33'); // 33.333333 → 33.33
    expect(s.balanceAmount).toBe('66.68');
  });

  it('a 0% deposit has no deposit due date', () => {
    const s = paymentSchedule(
      '50.00',
      {
        termType: 'DEPOSIT_BALANCE',
        depositPct: '0.00',
        balanceTrigger: 'ON_ARRIVAL',
        netDays: null,
      },
      ISSUED,
    );
    expect(s.depositAmount).toBe('0.00');
    expect(s.depositDueAt).toBeNull();
    expect(s.balanceAmount).toBe('50.00');
  });
});

describe('paymentsDue', () => {
  const base = {
    supplierName: 'Shenzhen Toys',
    currency: 'USD',
    depositAmount: null,
    depositDueAt: null,
    depositPaidAt: null,
    balanceAmount: null,
    balanceDueAt: null,
    balancePaidAt: null,
  };

  it('lists unpaid positive amounts of open orders, soonest first, unknown due dates last', () => {
    const due = paymentsDue([
      {
        ...base,
        id: 'a',
        poNumber: 'PO-2026-002',
        status: 'ISSUED',
        depositAmount: '675.00',
        depositDueAt: '2026-09-24T10:00:00.000Z',
        balanceAmount: '1575.00',
      },
      {
        ...base,
        id: 'b',
        poNumber: 'PO-2026-001',
        status: 'IN_PRODUCTION',
        depositAmount: '100.00',
        depositDueAt: '2026-09-01T00:00:00.000Z',
        depositPaidAt: '2026-09-02T00:00:00.000Z',
        balanceAmount: '900.00',
        balanceDueAt: '2026-10-01T00:00:00.000Z',
      },
      { ...base, id: 'c', poNumber: 'PO-2026-003', status: 'DRAFT', depositAmount: '5.00' },
      { ...base, id: 'd', poNumber: 'PO-2026-004', status: 'CANCELLED', balanceAmount: '5.00' },
      { ...base, id: 'e', poNumber: 'PO-2026-005', status: 'ISSUED', depositAmount: '0.00' },
    ]);
    expect(due.map((p) => [p.poNumber, p.kind, p.amount, p.dueAt])).toEqual([
      ['PO-2026-002', 'DEPOSIT', '675.00', '2026-09-24T10:00:00.000Z'],
      ['PO-2026-001', 'BALANCE', '900.00', '2026-10-01T00:00:00.000Z'],
      ['PO-2026-002', 'BALANCE', '1575.00', null],
    ]);
    expect(paymentsDue([], 3)).toEqual([]);
  });

  it('take limits the list', () => {
    const rows = ['1', '2', '3', '4'].map((n) => ({
      ...base,
      id: n,
      poNumber: `PO-2026-00${n}`,
      status: 'ISSUED' as const,
      depositAmount: '1.00',
    }));
    expect(paymentsDue(rows, 3)).toHaveLength(3);
  });
});

describe('formatPoNumber', () => {
  it('zero-pads to three digits and grows beyond 999', () => {
    expect(formatPoNumber(2026, 1)).toBe('PO-2026-001');
    expect(formatPoNumber(2026, 42)).toBe('PO-2026-042');
    expect(formatPoNumber(2027, 1234)).toBe('PO-2027-1234');
  });
});
