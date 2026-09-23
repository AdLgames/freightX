import { describe, expect, it } from 'vitest';
import { signupSchema } from './signup';

describe('signupSchema', () => {
  it('normalises a valid email', () => {
    expect(signupSchema.parse({ email: '  Jane.Doe@Example.COM ' })).toEqual({
      email: 'jane.doe@example.com',
    });
  });
  it('keeps a bounded source and an empty honeypot', () => {
    expect(signupSchema.parse({ email: 'a@b.co', website: '', source: 'landing' })).toEqual({
      email: 'a@b.co',
      website: '',
      source: 'landing',
    });
  });
  it('rejects malformed emails, over-long input, HTML in source and a filled honeypot', () => {
    expect(signupSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(signupSchema.safeParse({ email: 'a@b' }).success).toBe(false);
    expect(signupSchema.safeParse({ email: `${'a'.repeat(250)}@example.com` }).success).toBe(false);
    expect(signupSchema.safeParse({ email: 'a@b.co', source: '<img>' }).success).toBe(false);
    expect(signupSchema.safeParse({ email: 'a@b.co', website: 'http://bot.example' }).success).toBe(
      false,
    );
  });
});
