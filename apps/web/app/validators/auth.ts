import { z } from 'zod';
import { safeString } from './common';

/** Sign-in and workspace-shell form schemas (§7.1). */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must be 254 characters or fewer.')
  .pipe(z.email({ error: 'Enter a valid email address.' }));

export const loginSchema = z.object({
  email: emailSchema,
});

/** Magic-link token: 32 random bytes, base64url (43 characters). */
export const magicTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'That sign-in link is not valid.');

export const organizationNameSchema = safeString(120).refine(
  (s) => s.length >= 2,
  'Enter at least 2 characters.',
);

export const createOrganizationSchema = z.object({
  name: organizationNameSchema,
});

export const switchOrganizationSchema = z.object({
  organizationId: z.uuid({ error: 'Choose an organisation.' }),
});

export const DEFAULT_NEXT = '/app';
const PLACEHOLDER_ORIGIN = 'http://harbour.invalid';

/**
 * `next` after sign-in: a same-origin, relative path only. Anything else (absolute URLs,
 * protocol-relative `//host`, `/\host` which browsers treat as `//host`, control characters,
 * backslashes anywhere) falls back to `/app`. The returned value is re-serialised from the parsed
 * URL, so it cannot differ from what was validated.
 */
export const safeNext = (raw: unknown, fallback: string = DEFAULT_NEXT): string => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return fallback;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // Never bounce back into the sign-in pages themselves.
  if (path === '/login' || path.startsWith('/login/') || path.startsWith('/login?')) {
    return fallback;
  }
  return path;
};
