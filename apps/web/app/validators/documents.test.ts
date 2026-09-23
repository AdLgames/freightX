import { describe, expect, it } from 'vitest';
import { fieldErrors } from './common';
import {
  documentIdSchema,
  MAX_DOCUMENT_BYTES,
  uploadRequestSchema,
  vaultTabSchema,
} from './documents';

const QUOTE = '0f0f0f0f-0000-4000-8000-000000000001';

const parse = (input: Record<string, unknown>) => uploadRequestSchema.safeParse(input);
const errorsOf = (input: Record<string, unknown>) => {
  const r = parse(input);
  return r.success ? {} : fieldErrors(r.error.issues);
};

describe('uploadRequestSchema', () => {
  it('accepts an organisation PDF and canonicalises the content type and file name', () => {
    const r = parse({
      type: 'EORI_CONFIRMATION',
      scope: 'ORGANISATION',
      filename: '../../EORI confirmation "final".PDF',
      mimeType: 'application/pdf; charset=binary',
      sizeBytes: '1234',
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      type: 'EORI_CONFIRMATION',
      scope: 'ORGANISATION',
      quoteId: null,
      filename: 'EORI confirmation final.PDF',
      format: 'pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });
  });

  it('requires a quote for quote-scoped documents and keeps the quote id', () => {
    expect(
      errorsOf({
        type: 'COMMERCIAL_INVOICE',
        scope: 'QUOTE',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).toEqual({
      quoteId: 'Choose a quote.',
    });
    expect(
      errorsOf({
        type: 'COMMERCIAL_INVOICE',
        scope: 'QUOTE',
        quoteId: 'nope',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).toEqual({
      quoteId: 'Choose a quote.',
    });
    const ok = parse({
      type: 'PACKING_LIST',
      scope: 'QUOTE',
      quoteId: QUOTE,
      filename: 'pl.xlsx',
      mimeType: '',
      sizeBytes: 10,
    });
    expect(ok.data).toMatchObject({
      quoteId: QUOTE,
      format: 'xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('keeps organisation and quote document types apart', () => {
    expect(
      errorsOf({
        type: 'COMMERCIAL_INVOICE',
        scope: 'ORGANISATION',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).toEqual({
      type: 'That type belongs to a quote, not the organisation.',
    });
    expect(
      errorsOf({
        type: 'VAT_CERTIFICATE',
        scope: 'QUOTE',
        quoteId: QUOTE,
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).toEqual({
      type: 'That type belongs to the organisation, not a quote.',
    });
    // OTHER is allowed on both.
    expect(
      parse({
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'a.csv',
        mimeType: 'text/csv',
        sizeBytes: 1,
      }).success,
    ).toBe(true);
    expect(
      parse({
        type: 'OTHER',
        scope: 'QUOTE',
        quoteId: QUOTE,
        filename: 'a.csv',
        mimeType: 'text/csv',
        sizeBytes: 1,
      }).success,
    ).toBe(true);
  });

  it('enforces the extension / MIME allow-list and their agreement (§7.4)', () => {
    const base = { type: 'EORI_CONFIRMATION', scope: 'ORGANISATION', sizeBytes: 1 };
    expect(
      errorsOf({ ...base, filename: 'setup.exe', mimeType: 'application/pdf' }).filename,
    ).toMatch(/Only \.pdf, \.png, \.jpg, \.jpeg, \.xlsx, \.csv/);
    expect(errorsOf({ ...base, filename: 'noext', mimeType: 'application/pdf' }).filename).toMatch(
      /Only/,
    );
    expect(errorsOf({ ...base, filename: 'doc.pdf', mimeType: 'application/zip' }).filename).toBe(
      'That file type is not accepted (PDF, PNG, JPG, XLSX or CSV only).',
    );
    expect(errorsOf({ ...base, filename: 'photo.png', mimeType: 'application/pdf' }).filename).toBe(
      'The file extension does not match its type.',
    );
    expect(
      parse({ ...base, filename: 'photo.jpeg', mimeType: 'image/jpeg' }).data?.contentType,
    ).toBe('image/jpeg');
    expect(
      parse({ ...base, filename: 'list.csv', mimeType: 'application/vnd.ms-excel' }).data
        ?.contentType,
    ).toBe('text/csv');
    expect(
      parse({ ...base, filename: 'list.csv', mimeType: 'application/octet-stream' }).data
        ?.contentType,
    ).toBe('text/csv');
  });

  it('bounds the size to 1 byte … 25 MB', () => {
    const base = {
      type: 'EORI_CONFIRMATION',
      scope: 'ORGANISATION',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
    };
    expect(errorsOf({ ...base, sizeBytes: 0 }).sizeBytes).toBe('The file is empty.');
    expect(errorsOf({ ...base, sizeBytes: MAX_DOCUMENT_BYTES + 1 }).sizeBytes).toBe(
      'The file is larger than 25 MB.',
    );
    expect(errorsOf({ ...base, sizeBytes: '12.5' }).sizeBytes).toMatch(/whole number/);
    expect(errorsOf({ ...base, sizeBytes: 'abc' }).sizeBytes).toBeDefined();
    expect(parse({ ...base, sizeBytes: MAX_DOCUMENT_BYTES }).success).toBe(true);
  });

  it('rejects unknown types, scopes and shipments (Phase 2)', () => {
    expect(
      errorsOf({
        type: 'PASSPORT',
        scope: 'ORGANISATION',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }).type,
    ).toBeDefined();
    expect(
      errorsOf({
        type: 'OTHER',
        scope: 'SHIPMENT',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }).scope,
    ).toBeDefined();
  });
});

describe('small schemas', () => {
  it('document ids are UUIDs; tabs fall back to missing', () => {
    expect(documentIdSchema.safeParse(QUOTE).success).toBe(true);
    expect(documentIdSchema.safeParse('1 OR 1=1').success).toBe(false);
    expect(vaultTabSchema.parse('quotes')).toBe('quotes');
    expect(vaultTabSchema.parse('<script>')).toBe('missing');
    expect(vaultTabSchema.parse(undefined)).toBe('missing');
  });
});
