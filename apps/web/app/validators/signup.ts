import { z } from 'zod';
import { safeString } from './common';

/** Email signup form (Phase 0 gate metric: 50 signups). */
export const signupSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Email must be 254 characters or fewer.')
    .pipe(z.email({ error: 'Enter a valid email address.' })),
  /** Honeypot: real users never fill this in. Must be empty. */
  website: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '', 'Unexpected value.'),
  /** Where the signup came from, e.g. "landing" — free text but bounded. */
  source: safeString(40).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
