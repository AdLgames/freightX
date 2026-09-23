import { redirect } from 'react-router';
import type { Route } from './+types/app.documents_.$id.download';
import { requireOrgContext } from '../services/auth.server';
import { downloadUrl, requireDocumentStorage } from '../services/documents/documents.server';
import { pageError } from '../services/page-error';
import { documentIdSchema } from '../validators/documents';

/**
 * `GET /app/documents/:id/download` (§7.4 "served only via presigned GET after an authorisation
 * check"): permission `doc.download`, tenant-scoped lookup, audit `doc.download`, then a 302 to a
 * 5-minute presigned URL with `Content-Disposition: attachment; filename="<sanitised>"`. The
 * presigned URL is never stored. A document outside this organisation, deleted or rejected is a
 * 404 — nothing distinguishes the cases.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.download' });
  const { storage } = await requireDocumentStorage();
  const id = documentIdSchema.safeParse(params.id);
  const url = id.success ? await downloadUrl(ctx, storage, id.data, request) : null;
  if (!url) {
    throw pageError(
      404,
      'Document not found',
      'That document does not exist or cannot be downloaded.',
    );
  }
  return redirect(url, { headers: { 'Cache-Control': 'no-store' } });
};
