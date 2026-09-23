import { describe, expect, it } from 'vitest';
import {
  createOrganizationSchema,
  loginSchema,
  magicTokenSchema,
  safeNext,
  switchOrganizationSchema,
} from './auth';

describe('safeNext', () => {
  it.each([
    '//evil.com',
    '//evil.com/app',
    'https://evil.com',
    'http://localhost/app',
    '/\\evil.com',
    '/\\/evil.com',
    '\\\\evil.com',
    'javascript:alert(1)',
    'app',
    '',
    '/app\n/x',
    '/login',
    '/login/verify?token=x',
    `/${'a'.repeat(600)}`,
    null,
    42,
  ])('rejects %j', (raw) => {
    expect(safeNext(raw)).toBe('/app');
  });

  it('keeps same-origin relative paths, with query and hash', () => {
    expect(safeNext('/app/quotes')).toBe('/app/quotes');
    expect(safeNext('/app/quotes?status=DRAFT#top')).toBe('/app/quotes?status=DRAFT#top');
    expect(safeNext('/app/../app/products')).toBe('/app/products');
    // Percent-encoded CR/LF stay encoded: harmless in a Location header.
    expect(safeNext('/%0d%0aSet-Cookie:x')).toBe('/%0d%0aSet-Cookie:x');
  });
});

describe('auth form schemas', () => {
  it('normalises the email (trim, lower-case) and rejects junk', () => {
    expect(loginSchema.parse({ email: '  Jane.Doe@Example.CO.UK ' }).email).toBe(
      'jane.doe@example.co.uk',
    );
    for (const bad of ['', 'jane', 'jane@', '@example.com', `${'a'.repeat(250)}@x.io`]) {
      expect(loginSchema.safeParse({ email: bad }).success, bad).toBe(false);
    }
  });

  it('accepts only 43-character base64url magic tokens', () => {
    expect(magicTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(magicTokenSchema.safeParse('A'.repeat(42)).success).toBe(false);
    expect(magicTokenSchema.safeParse(`${'A'.repeat(42)}=`).success).toBe(false);
  });

  it('organisation names are trimmed, 2 to 120 characters, no HTML', () => {
    expect(createOrganizationSchema.parse({ name: '  Acme Imports Ltd ' }).name).toBe(
      'Acme Imports Ltd',
    );
    expect(createOrganizationSchema.safeParse({ name: ' A ' }).success).toBe(false);
    expect(createOrganizationSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(createOrganizationSchema.safeParse({ name: '<b>Acme</b>' }).success).toBe(false);
    expect(createOrganizationSchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
  });

  it('org switch takes a UUID only', () => {
    expect(switchOrganizationSchema.safeParse({ organizationId: 'org-b' }).success).toBe(false);
    expect(
      switchOrganizationSchema.safeParse({ organizationId: '0b7c7a38-4a51-4a8e-9a55-8f7f0a0c1d2e' })
        .success,
    ).toBe(true);
  });
});
