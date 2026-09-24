import { describe, expect, it } from 'vitest';
import {
  billFieldErrors,
  billFormSchema,
  parseBillForm,
  paymentFormSchema,
  readBillForm,
  signedAmount,
  type BillFormValues,
} from './bill';

const PO = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';

const values = (
  scalars: Partial<Record<string, string>> = {},
  lines: Array<Partial<BillFormValues['lines'][number]>> = [{}],
): BillFormValues => ({
  scalars: {
    vendorType: 'FORWARDER',
    supplierId: '',
    vendorName: 'Fast Freight Ltd',
    billType: 'FREIGHT_INVOICE',
    referenceNumber: 'FF-1001',
    isCreditNote: '',
    currency: 'GBP',
    totalAmount: '520.00',
    issuedOn: '2026-09-20',
    dueOn: '',
    notes: '',
    ...scalars,
  },
  lines: lines.map((l) => ({
    purchaseOrderId: PO,
    purchaseOrderItemId: '',
    costCategory: 'FREIGHT_TO_BORDER',
    unplannedReason: '',
    description: 'Ocean freight',
    amount: '520.00',
    ...l,
  })),
});

describe('billFormSchema', () => {
  it('accepts a forwarder invoice and normalises the vendor fields', () => {
    const r = parseBillForm(values());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      vendorType: 'FORWARDER',
      vendorName: 'Fast Freight Ltd',
      supplierId: undefined,
      isCreditNote: false,
      totalAmount: '520.00',
      dueOn: undefined,
    });
    expect(r.input.lines[0]).toMatchObject({
      purchaseOrderId: PO,
      purchaseOrderItemId: undefined,
      costCategory: 'FREIGHT_TO_BORDER',
      unplannedReason: undefined,
      amount: '520.00',
    });
  });

  it('a supplier bill needs the supplier and drops any typed vendor name; other vendors need a name', () => {
    const noSupplier = parseBillForm(values({ vendorType: 'SUPPLIER' }));
    expect(noSupplier.ok).toBe(false);
    if (!noSupplier.ok) expect(noSupplier.errors.supplierId).toMatch(/Choose the supplier/);
    const supplier = parseBillForm(
      values({ vendorType: 'SUPPLIER', supplierId: SUPPLIER, vendorName: 'ignored' }),
    );
    expect(supplier.ok).toBe(true);
    if (supplier.ok) {
      expect(supplier.input.supplierId).toBe(SUPPLIER);
      expect(supplier.input.vendorName).toBeUndefined();
    }
    const noName = parseBillForm(values({ vendorType: 'HMRC', vendorName: '' }));
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.errors.vendorName).toMatch(/name of the company/);
  });

  it('an unplanned line needs a reason; a reason on any other category is dropped', () => {
    const missing = parseBillForm(values({}, [{ costCategory: 'UNPLANNED' }]));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.line_0_unplannedReason).toMatch(/why/);
    const ok = parseBillForm(
      values({}, [{ costCategory: 'UNPLANNED', unplannedReason: 'DEMURRAGE' }]),
    );
    expect(ok.ok).toBe(true);
    const stray = parseBillForm(values({}, [{ unplannedReason: 'STORAGE' }]));
    expect(stray.ok).toBe(true);
    if (stray.ok) expect(stray.input.lines[0]!.unplannedReason).toBeUndefined();
  });

  it('dates: real calendar days, due on or after issue', () => {
    const bad = parseBillForm(values({ issuedOn: '2026-02-30' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.issuedOn).toMatch(/calendar date/);
    const before = parseBillForm(values({ dueOn: '2026-09-19' }));
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.errors.dueOn).toMatch(/before the issue date/);
    expect(parseBillForm(values({ dueOn: '2026-09-20' })).ok).toBe(true);
  });

  it('needs at least one line, a reference, a supported currency and a non-negative 2 dp total', () => {
    const none = parseBillForm({ ...values(), lines: [] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.lines).toMatch(/at least one line/);
    const blank = parseBillForm(values({ referenceNumber: '  ' }));
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.referenceNumber).toMatch(/required/);
    expect(parseBillForm(values({ currency: 'XXX' })).ok).toBe(false);
    expect(parseBillForm(values({ totalAmount: '-1' })).ok).toBe(false);
    expect(parseBillForm(values({ totalAmount: '1.234' })).ok).toBe(false);
    expect(parseBillForm(values({ totalAmount: '0' })).ok).toBe(true);
  });

  it('line amounts may be negative (a discount) but never zero; ids must be UUIDs', () => {
    expect(signedAmount.safeParse('-10.50').success).toBe(true);
    expect(signedAmount.safeParse('0.00').success).toBe(false);
    expect(signedAmount.safeParse('1e3').success).toBe(false);
    expect(signedAmount.safeParse('1.234').success).toBe(false);
    const item = parseBillForm(values({}, [{ purchaseOrderItemId: ITEM }]));
    expect(item.ok).toBe(true);
    const badPo = parseBillForm(values({}, [{ purchaseOrderId: 'nope' }]));
    expect(badPo.ok).toBe(false);
    if (!badPo.ok) expect(badPo.errors.line_0_purchaseOrderId).toBeDefined();
  });

  it('the checkbox becomes a boolean', () => {
    const on = billFormSchema.safeParse({
      ...values({ isCreditNote: 'on' }).scalars,
      lines: values().lines,
    });
    expect(on.success && on.data.isCreditNote).toBe(true);
  });
});

describe('readBillForm / billFieldErrors', () => {
  it('reads the flat form in line order, keeping blank rows that were rendered', () => {
    const form = new FormData();
    form.set('vendorType', 'FORWARDER');
    form.set('line_1_description', 'Second');
    form.set('line_1_amount', '2');
    form.set('line_1_purchaseOrderId', PO);
    form.set('line_0_description', '');
    form.set('line_0_amount', '');
    const v = readBillForm(form);
    expect(v.scalars.vendorType).toBe('FORWARDER');
    expect(v.scalars.currency).toBe('');
    expect(v.lines).toHaveLength(2);
    expect(v.lines[0]).toMatchObject({ description: '', amount: '', purchaseOrderId: '' });
    expect(v.lines[1]).toMatchObject({ description: 'Second', amount: '2', purchaseOrderId: PO });
    expect(readBillForm(null).lines).toEqual([]);
  });

  it('maps `lines.3.amount` to the input name `line_3_amount`', () => {
    const parsed = billFormSchema.safeParse({
      ...values().scalars,
      lines: [
        values().lines[0],
        values().lines[0],
        values().lines[0],
        { ...values().lines[0], amount: 'x' },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(billFieldErrors(parsed.error.issues)).toHaveProperty('line_3_amount');
    }
  });
});

describe('paymentFormSchema', () => {
  it('needs a date, a positive amount and a positive rate up to 6 dp', () => {
    const ok = paymentFormSchema.safeParse({
      paidOn: '2026-09-24',
      amount: '675.00',
      fxRate: '0.781234',
      reference: '',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.reference).toBeUndefined();
    expect(
      paymentFormSchema.safeParse({ paidOn: '2026-09-24', amount: '0', fxRate: '1' }).success,
    ).toBe(false);
    expect(
      paymentFormSchema.safeParse({ paidOn: '2026-09-24', amount: '1', fxRate: '0' }).success,
    ).toBe(false);
    expect(
      paymentFormSchema.safeParse({ paidOn: '2026-09-24', amount: '1', fxRate: '0.1234567' })
        .success,
    ).toBe(false);
  });
});
