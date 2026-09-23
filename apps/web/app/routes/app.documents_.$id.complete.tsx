import { redirect } from 'react-router';
import type { Route } from './+types/app.documents_.$id.complete';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { completeUpload, requireDocumentStorage } from '../services/documents/documents.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { documentIdSchema } from '../validators/documents';

/**
 * `POST /app/documents/:id/complete` (§7.4 "on upload-complete"): the client says the PUT is
 * done. CSRF-checked; the object is head()ed and must match the record before the document moves
 * to SCANNING and the scan job is enqueued. Answers JSON to `Accept: application/json` (the
 * upload script) and redirects for a plain form post.
 */
export const loader = () => redirect('/app/documents');

const wantsJson = (request: Request) =>
  (request.headers.get('accept') ?? '').includes('application/json');

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
  const services = await requireDocumentStorage();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const id = documentIdSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Document not found', 'That document does not exist.');

  const result = await completeUpload(ctx, services, id.data, request);
  if (wantsJson(request)) {
    return result.ok
      ? json({ ok: true, status: result.status, next: '/app/documents?notice=uploaded' }, 200)
      : json(
          { ok: false, code: result.code, message: result.message },
          result.code === 'NOT_FOUND' ? 404 : 400,
        );
  }
  if (result.ok) return redirect('/app/documents?notice=uploaded');
  if (result.code === 'NOT_FOUND') throw pageError(404, 'Document not found', result.message);
  if (result.code === 'REJECTED') return redirect('/app/documents?notice=rejected');
  throw pageError(400, 'Upload not complete', result.message);
};
