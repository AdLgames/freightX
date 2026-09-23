import { redirect } from 'react-router';
import type { Route } from './+types/app.documents_.$id.verify';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requireDocumentStorage, verifyDocument } from '../services/documents/documents.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { documentIdSchema } from '../validators/documents';

/**
 * `POST /app/documents/:id/verify`: OWNER/ADMIN (`doc.verify`) mark a CLEAN document as checked
 * by a person → VERIFIED (§6.1 accepts either). Only a scanned-clean document qualifies; an
 * unscanned "Uploaded" one cannot be verified into bookability.
 */
export const loader = () => redirect('/app/documents');

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.verify' });
  await requireDocumentStorage();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const id = documentIdSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Document not found', 'That document does not exist.');
  const result = await verifyDocument(ctx, id.data, request);
  if (!result.ok) throw pageError(400, 'Cannot verify this document', result.message);
  return redirect('/app/documents?notice=verified');
};
