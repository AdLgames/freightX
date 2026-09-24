import { describe, expect, it } from 'vitest';
import {
  BUILDER_INPUT_VERSION,
  MAX_QUOTE_LINES,
  addLineSchema,
  buildQuoteFormSchema,
  builderInputSchema,
  builderInputToValues,
  lineFieldName,
  parseQuoteForm,
  quickDutySchema,
  quoteFieldErrors,
  quoteListSchema,
  readQuoteForm,
  toBuilderInput,
} from './quote';

const LANES = ['CNSHA:GBFXT:SEA_LCL', 'CNPVG:GBLHR:AIR'];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const base = {
  incoterm: 'FOB',
  lane: 'CNSHA:GBFXT:SEA_LCL',
  dutyPayment: 'BROKER_DEFERMENT',
  vatRegistered: 'on',
  line_0_productId: P1,
  line_0_quantity: '500',
};

describe('quote builder form', () => {
  const schema = buildQuoteFormSchema(LANES);

  it('reads flat line groups in order and skips empty ones', () => {
    const values = readQuoteForm(
      form({
        ...base,
        line_3_productId: P2,
        line_3_quantity: '10',
        line_3_assistsGbp: '12.50',
        line_3_preferenceClaimed: 'on',
      }),
    );
    expect(values.lines).toEqual([
      { productId: P1, quantity: '500', assistsGbp: '', preferenceClaimed: '' },
      { productId: P2, quantity: '10', assistsGbp: '12.50', preferenceClaimed: 'on' },
    ]);
    expect(values.scalars.incoterm).toBe('FOB');
    expect(lineFieldName(3, 'assistsGbp')).toBe('line_3_assistsGbp');
  });

  it('parses a valid form: decimal strings stay strings, quantities become integers', () => {
    const parsed = parseQuoteForm(
      schema,
      readQuoteForm(form({ ...base, insurancePremiumGbp: '25.00', line_0_assistsGbp: '100' })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.lines[0]).toEqual({
      productId: P1,
      quantity: 500,
      assistsGbp: '100',
      preferenceClaimed: false,
    });
    expect(parsed.input.insurancePremiumGbp).toBe('25.00');
    expect(parsed.input.vatRegistered).toBe(true);
    expect(parsed.input.vatPostponed).toBe(false);
    expect(parsed.input.manualFxRate).toBeUndefined();
  });

  it('rejects an empty quote, unknown lanes, bad quantities and duplicate products by field name', () => {
    const none = parseQuoteForm(schema, readQuoteForm(form({ incoterm: 'FOB', lane: LANES[0]! })));
    expect(none).toMatchObject({
      ok: false,
      errors: { lines: expect.stringMatching(/at least one/) },
    });

    const bad = parseQuoteForm(
      schema,
      readQuoteForm(
        form({
          ...base,
          lane: 'XXXXX:GBFXT:SEA_LCL',
          line_0_quantity: '0',
          line_1_productId: P1,
          line_1_quantity: '5',
        }),
      ),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.lane).toMatch(/route/);
    expect(bad.errors.line_0_quantity).toMatch(/at least 1/);
    expect(bad.errors.line_1_productId).toMatch(/already on the quote/);
  });

  it('manual FX needs both currency and rate, and never GBP', () => {
    const half = parseQuoteForm(schema, readQuoteForm(form({ ...base, manualFxRate: '0.78' })));
    expect(half).toMatchObject({ ok: false, errors: { manualFxRate: expect.any(String) } });
    const gbp = parseQuoteForm(
      schema,
      readQuoteForm(form({ ...base, manualFxRate: '1', manualFxCurrency: 'GBP' })),
    );
    expect(gbp).toMatchObject({ ok: false, errors: { manualFxCurrency: expect.any(String) } });
    const ok = parseQuoteForm(
      schema,
      readQuoteForm(form({ ...base, manualFxRate: '0.78', manualFxCurrency: 'USD' })),
    );
    expect(ok.ok).toBe(true);
  });

  it('supplier freight UK leg needs the total', () => {
    const r = parseQuoteForm(schema, readQuoteForm(form({ ...base, supplierFreightUkGbp: '50' })));
    expect(r).toMatchObject({ ok: false, errors: { supplierFreightTotalGbp: expect.any(String) } });
  });

  it('caps the number of lines', () => {
    const fields: Record<string, string> = { ...base };
    for (let i = 0; i < MAX_QUOTE_LINES + 1; i += 1) {
      fields[`line_${i}_productId`] = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      fields[`line_${i}_quantity`] = '1';
    }
    // readQuoteForm only reads MAX_QUOTE_LINES groups, so the schema's max is a second guard.
    expect(readQuoteForm(form(fields)).lines).toHaveLength(MAX_QUOTE_LINES);
  });

  it('builder input round-trips through toBuilderInput / builderInputToValues', () => {
    const parsed = parseQuoteForm(
      schema,
      readQuoteForm(
        form({ ...base, vatPostponed: 'on', brokerFeePct: '2.5', line_0_preferenceClaimed: 'on' }),
      ),
    );
    if (!parsed.ok) throw new Error('expected ok');
    const stored = toBuilderInput(parsed.input);
    expect(stored.version).toBe(BUILDER_INPUT_VERSION);
    expect(builderInputSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    const values = builderInputToValues(stored);
    expect(values.scalars).toMatchObject({
      incoterm: 'FOB',
      vatRegistered: 'on',
      vatPostponed: 'on',
      brokerFeePct: '2.5',
      supplierId: '',
    });
    expect(values.lines).toEqual([
      { productId: P1, quantity: '500', assistsGbp: '', preferenceClaimed: 'on' },
    ]);
    expect(builderInputSchema.safeParse({ ...stored, version: 99 }).success).toBe(false);
  });

  it('maps zod line paths to input names', () => {
    const r = schema.safeParse({ ...base, lines: [{ productId: 'nope', quantity: 'x' }] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const errors = quoteFieldErrors(r.error.issues);
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(['line_0_productId', 'line_0_quantity']),
    );
  });

  it('add-line row: product id and quantity', () => {
    expect(addLineSchema.safeParse({ addProductId: P1, addQuantity: '3' }).success).toBe(true);
    expect(addLineSchema.safeParse({ addProductId: '', addQuantity: '3' }).success).toBe(false);
    expect(addLineSchema.safeParse({ addProductId: P1, addQuantity: '1.5' }).success).toBe(false);
  });
});

describe('quotes list and quick duty', () => {
  it('list filter tolerates junk', () => {
    expect(quoteListSchema.parse({ status: 'NOPE', page: 'x' })).toEqual({
      status: undefined,
      page: 1,
    });
    expect(quoteListSchema.parse({ status: 'READY', page: '3' })).toEqual({
      status: 'READY',
      page: 3,
    });
  });

  it('quick duty: HS code normalised, GBP value positive, any ISO country', () => {
    expect(
      quickDutySchema.parse({
        hsCode: '9503.00.41.00',
        invoiceValueGbp: '2500',
        originCountry: 'jp',
        preferenceClaimed: 'on',
      }),
    ).toEqual({
      hsCode: '9503004100',
      invoiceValueGbp: '2500',
      originCountry: 'JP',
      preferenceClaimed: true,
    });
    expect(
      quickDutySchema.safeParse({ hsCode: '950300410', invoiceValueGbp: '0', originCountry: 'ZZ' })
        .success,
    ).toBe(false);
  });
});
