import { redirect } from 'react-router';
import type { Route } from './+types/app.documents_.presign';
import { getApp } from '../services/app.server';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { createUploadRecord, requireDocumentStorage } from '../services/documents/documents.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import { fieldErrors } from '../validators/common';
import { uploadRequestSchema } from '../validators/documents';

/**
 * Resource route used by /documents-upload.js (§7.4 presigned PUT). POST, CSRF-checked,
 * form-encoded metadata (type, scope, quoteId, filename, mimeType, sizeBytes) → JSON:
 *
 *   201 { documentId, upload: { url, method, headers, expiresAt }, completeUrl }
 *   400 { errors: { field: message } }
 *
 * Content type is decided server-side from the extension + declared MIME and signed into the
 * URL; size is enforced by the local backend on receipt and re-checked with head() on complete.
 */
export const loader = () => redirect('/app/documents/new');

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
  const { storage } = await requireDocumentStorage();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const log = requestLogger((await getApp()).logger, request);

  const str = (name: string) => {
    const v = form?.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const parsed = uploadRequestSchema.safeParse({
    type: str('type'),
    scope: str('scope'),
    quoteId: str('quoteId') || undefined,
    filename: str('filename') ?? '',
    mimeType: str('mimeType') ?? '',
    sizeBytes: str('sizeBytes'),
  });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('documents.upload_invalid', { fields: Object.keys(errors), userId: ctx.user.id });
    return json({ errors }, 400);
  }
  const result = await createUploadRecord(ctx, storage, parsed.data, request);
  if (!result.ok) return json({ errors: { [result.field]: result.message } }, 400);
  return json(
    {
      documentId: result.documentId,
      version: result.version,
      upload: {
        url: result.upload.url,
        method: result.upload.method,
        headers: result.upload.headers,
        expiresAt: result.upload.expiresAt.toISOString(),
      },
      completeUrl: `/app/documents/${result.documentId}/complete`,
    },
    201,
  );
};
