import {
  ALLOWED_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
  resolveDeclaredFormat,
  sanitiseFilename,
} from '@harbour/adapters';
import { z } from 'zod';
import {
  DOCUMENT_TYPES,
  ORGANISATION_DOCUMENT_TYPES,
  QUOTE_DOCUMENT_TYPES,
  type DocumentTypeValue,
} from '../components/document-labels';

/**
 * Document vault inputs (§5.6 zod at the boundary; §7.4 upload rules). The declared MIME type
 * and extension are checked here; the bytes are checked again by the scan pipeline after upload.
 * Server-only (imports @harbour/adapters): route components take their labels from
 * `components/document-labels.ts` instead.
 */

/** Same grammar as `UUID_RE` in @harbour/db. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §6.1 booking precondition: these two must be CLEAN/VERIFIED for an accepted quote. */
export const REQUIRED_QUOTE_DOCUMENT_TYPES = ['COMMERCIAL_INVOICE', 'PACKING_LIST'] as const;

export { DOCUMENT_TYPES, ORGANISATION_DOCUMENT_TYPES, QUOTE_DOCUMENT_TYPES };
export type { DocumentTypeValue };

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

/** Document scopes a user may upload to in Phase 1 (SHIPMENT is Phase 2). */
export const uploadScopeSchema = z.enum(['ORGANISATION', 'QUOTE']);
export type UploadScope = z.infer<typeof uploadScopeSchema>;

const filenameSchema = z
  .string()
  .min(1, 'Choose a file.')
  .max(1024)
  .transform((s) => sanitiseFilename(s));

const sizeSchema = z.coerce
  .number()
  .int('Size must be a whole number of bytes.')
  .min(1, 'The file is empty.')
  .max(MAX_DOCUMENT_BYTES, 'The file is larger than 25 MB.');

/**
 * `POST /app/documents/new` and `/app/documents/presign`: what the user picked, before any bytes
 * move. `mimeType` may be blank (browsers without a mapping); the extension then decides and the
 * content check after upload has the last word.
 */
export const uploadRequestSchema = z
  .object({
    type: documentTypeSchema,
    scope: uploadScopeSchema,
    quoteId: z.string().regex(UUID_RE, 'Choose a quote.').optional(),
    filename: filenameSchema,
    mimeType: z.string().max(255).default(''),
    sizeBytes: sizeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'QUOTE' && !v.quoteId) {
      ctx.addIssue({ code: 'custom', path: ['quoteId'], message: 'Choose a quote.' });
    }
    if (
      v.scope === 'ORGANISATION' &&
      !(ORGANISATION_DOCUMENT_TYPES as readonly string[]).includes(v.type)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'That type belongs to a quote, not the organisation.',
      });
    }
    if (v.scope === 'QUOTE' && !(QUOTE_DOCUMENT_TYPES as readonly string[]).includes(v.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'That type belongs to the organisation, not a quote.',
      });
    }
  })
  .transform((v, ctx) => {
    const declared = resolveDeclaredFormat({ filename: v.filename, mimeType: v.mimeType });
    if (!declared.ok) {
      const message =
        declared.problem === 'EXTENSION_NOT_ALLOWED'
          ? `Only ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(', ')} files are accepted.`
          : declared.problem === 'MIME_NOT_ALLOWED'
            ? 'That file type is not accepted (PDF, PNG, JPG, XLSX or CSV only).'
            : 'The file extension does not match its type.';
      ctx.addIssue({ code: 'custom', path: ['filename'], message });
      return z.NEVER;
    }
    return {
      type: v.type,
      scope: v.scope,
      quoteId: v.scope === 'QUOTE' ? (v.quoteId as string) : null,
      filename: v.filename,
      format: declared.format,
      /** The canonical MIME type that gets signed and stored — never the client's string. */
      contentType: declared.contentType,
      sizeBytes: v.sizeBytes,
    };
  });
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const documentIdSchema = z.string().regex(UUID_RE);

/** Which tab of the vault to show; anything else falls back to the first. */
export const vaultTabSchema = z.enum(['missing', 'quotes', 'organisation']).catch('missing');
export type VaultTab = z.infer<typeof vaultTabSchema>;

export { MAX_DOCUMENT_BYTES, ALLOWED_EXTENSIONS };
