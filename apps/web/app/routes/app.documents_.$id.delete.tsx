import { redirect } from 'react-router';
import type { Route } from './+types/app.documents_.$id.delete';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { deleteDocument, requireDocumentStorage } from '../services/documents/documents.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { documentIdSchema } from '../validators/documents';

/** `POST /app/documents/:id/delete`: soft delete (`deletedAt`), object removed, audit `doc.delete`. */
export const loader = () => redirect('/app/documents');

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
  const { storage } = await requireDocumentStorage();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const id = documentIdSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Document not found', 'That document does not exist.');
  const result = await deleteDocument(ctx, storage, id.data, request);
  if (!result.ok) throw pageError(404, 'Document not found', result.message);
  return redirect('/app/documents?notice=deleted');
};
