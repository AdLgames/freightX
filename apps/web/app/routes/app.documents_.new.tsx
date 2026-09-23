import {
  MaxFileSizeExceededError,
  parseFormData,
  type FileUpload,
} from '@mjackson/form-data-parser';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.documents_.new';
import { CsrfInput } from '../components/csrf';
import {
  DOCUMENT_TYPE_LABELS,
  ORGANISATION_DOCUMENT_TYPES,
  QUOTE_DOCUMENT_TYPES,
  shortId,
} from '../components/document-labels';
import { getApp } from '../services/app.server';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import {
  listUploadTargets,
  requireDocumentStorage,
  serverSideUpload,
} from '../services/documents/documents.server';
import { requestLogger } from '../services/logger.server';
import { MAX_FORM_BYTES } from '../services/request.server';
import { fieldErrors } from '../validators/common';
import { MAX_DOCUMENT_BYTES, uploadRequestSchema } from '../validators/documents';

/**
 * Upload page (§7.4). Pick a type, a target (the organisation, or one of its quotes) and a file.
 *
 *   With JavaScript   /documents-upload.js intercepts the submit: POST /app/documents/presign
 *                     (metadata only) → PUT the file straight to storage → POST
 *                     /app/documents/:id/complete. The bytes never pass through the app.
 *   Without JS        this route's action receives the multipart form and streams the file to
 *                     storage server-side with the same limits, then completes (documented as
 *                     the no-JS and development path only).
 *
 * M4 links here with `?quoteId=<id>`; the missing-files list adds `&type=`.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Upload a document — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const UUID = /^[0-9a-f-]{36}$/i;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
  await requireDocumentStorage();
  const quotes = await listUploadTargets(ctx);
  const url = new URL(request.url);
  const quoteId = url.searchParams.get('quoteId');
  const type = url.searchParams.get('type');
  const scope = url.searchParams.get('scope');
  const preset = {
    quoteId: quoteId && UUID.test(quoteId) && quotes.some((q) => q.id === quoteId) ? quoteId : null,
    type: type && type in DOCUMENT_TYPE_LABELS ? type : null,
    scope:
      scope === 'ORGANISATION'
        ? 'ORGANISATION'
        : quoteId
          ? 'QUOTE'
          : quotes.length > 0
            ? 'QUOTE'
            : 'ORGANISATION',
  } as const;
  return data({ quotes, preset, maxBytes: MAX_DOCUMENT_BYTES }, { headers: ctx.headers });
};

type FormValues = { type?: string; scope?: string; quoteId?: string };
type ActionErrors = Record<string, string>;
const invalid = (errors: ActionErrors, values: FormValues = {}) =>
  data({ errors, values }, { status: 400 });
const TOO_LARGE: ActionErrors = { _form: 'The file is larger than 25 MB.' };

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
  const services = await requireDocumentStorage();
  const log = requestLogger((await getApp()).logger, request);

  // The multipart body is parsed by @mjackson/form-data-parser so the file streams instead of
  // being buffered; the one file part is kept as a stream and consumed once validation passes.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return invalid({ _form: 'Choose a file to upload.' });
  }
  let file: FileUpload | null = null;
  let form: FormData;
  try {
    form = await parseFormData(
      request,
      { maxFileSize: MAX_DOCUMENT_BYTES, maxFiles: 1, maxHeaderSize: MAX_FORM_BYTES },
      (upload) => {
        if (upload.fieldName === 'file' && file === null) file = upload;
        return null;
      },
    );
  } catch (err) {
    if (err instanceof MaxFileSizeExceededError) {
      return invalid(TOO_LARGE);
    }
    log.info('documents.upload_bad_form', { error: err instanceof Error ? err.name : 'unknown' });
    return invalid({ _form: 'The upload could not be read. Try again.' });
  }
  await requireCsrf(request, form, ctx.session);

  const chosen = file as FileUpload | null;
  const str = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const values: FormValues = { type: str('type'), scope: str('scope'), quoteId: str('quoteId') };
  const parsed = uploadRequestSchema.safeParse({
    type: values.type,
    scope: values.scope,
    quoteId: values.quoteId || undefined,
    filename: chosen?.name ?? '',
    mimeType: chosen?.type ?? '',
    sizeBytes: chosen?.size ?? 0,
  });
  if (!parsed.success || !chosen) {
    const errors: ActionErrors = parsed.success
      ? { filename: 'Choose a file.' }
      : fieldErrors(parsed.error.issues);
    log.info('documents.upload_invalid', { fields: Object.keys(errors), userId: ctx.user.id });
    return invalid(errors, values);
  }

  const result = await serverSideUpload(ctx, services, parsed.data, chosen.stream(), request);
  if (!result.ok) {
    if ('field' in result) return invalid({ [result.field]: result.message }, values);
    return invalid({ _form: result.message }, values);
  }
  const tab = parsed.data.scope === 'ORGANISATION' ? 'organisation' : 'quotes';
  return redirect(`/app/documents?tab=${tab}&notice=uploaded`);
};

export default function NewDocument({ loaderData, actionData }: Route.ComponentProps) {
  const { quotes, preset, maxBytes } = loaderData;
  const errors: ActionErrors = actionData?.errors ?? {};
  const values: FormValues = actionData?.values ?? {};
  const scope = values.scope || preset.scope;
  const type = values.type || preset.type || '';
  const quoteId = values.quoteId || preset.quoteId || '';
  const err = (name: string) => (name in errors ? errors[name] : undefined);
  return (
    <section className="narrow-page">
      <h1>Upload a document</h1>
      <p>
        PDF, PNG, JPG, XLSX or CSV, up to 25 MB. Files are checked for type and size and, where a
        scanner is configured, scanned for malware before they can be used.
      </p>
      <Form
        method="post"
        encType="multipart/form-data"
        data-upload-form
        data-presign-url="/app/documents/presign"
        data-max-bytes={maxBytes}
      >
        <CsrfInput />
        {err('_form') ? (
          <p className="field-error" role="alert">
            {err('_form')}
          </p>
        ) : null}

        <fieldset className={`field radios${err('scope') ? ' has-error' : ''}`}>
          <legend className="label">What is it for?</legend>
          <div className="check">
            <input
              type="radio"
              id="scope-org"
              name="scope"
              value="ORGANISATION"
              defaultChecked={scope === 'ORGANISATION'}
            />
            <label htmlFor="scope-org">
              The organisation (EORI, VAT, representation authority)
            </label>
          </div>
          <div className="check">
            <input
              type="radio"
              id="scope-quote"
              name="scope"
              value="QUOTE"
              defaultChecked={scope === 'QUOTE'}
              disabled={quotes.length === 0}
            />
            <label htmlFor="scope-quote">
              A quote{quotes.length === 0 ? <span className="muted"> (no quotes yet)</span> : null}
            </label>
          </div>
        </fieldset>

        <div className={`field${err('quoteId') ? ' has-error' : ''}`} data-quote-field>
          <label htmlFor="quoteId">Quote</label>
          {err('quoteId') ? (
            <span className="field-error" id="quoteId-error">
              {err('quoteId')}
            </span>
          ) : null}
          <select id="quoteId" name="quoteId" defaultValue={quoteId} disabled={quotes.length === 0}>
            <option value="">Choose a quote</option>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>
                Quote {shortId(q.id)} — {q.status.toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div className={`field${err('type') ? ' has-error' : ''}`}>
          <label htmlFor="type">Document type</label>
          {err('type') ? (
            <span className="field-error" id="type-error">
              {err('type')}
            </span>
          ) : null}
          <select id="type" name="type" defaultValue={type} required>
            <option value="">Choose a type</option>
            <optgroup label="Organisation" data-scope="ORGANISATION">
              {ORGANISATION_DOCUMENT_TYPES.map((t) => (
                <option key={`o-${t}`} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Quote" data-scope="QUOTE">
              {QUOTE_DOCUMENT_TYPES.map((t) => (
                <option key={`q-${t}`} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className={`field${err('filename') ? ' has-error' : ''}`}>
          <label htmlFor="file">File</label>
          <span className="hint" id="file-hint">
            .pdf, .png, .jpg, .xlsx or .csv — 25 MB at most.
          </span>
          {err('filename') ? (
            <span className="field-error" id="file-error">
              {err('filename')}
            </span>
          ) : null}
          <input
            id="file"
            name="file"
            type="file"
            required
            accept=".pdf,.png,.jpg,.jpeg,.xlsx,.csv,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            aria-describedby={err('filename') ? 'file-hint file-error' : 'file-hint'}
          />
        </div>

        <p className="upload-status" data-upload-status aria-live="polite"></p>
        <button type="submit" className="button">
          Upload
        </button>
        <Link to="/app/documents" className="button secondary">
          Cancel
        </Link>
      </Form>
      <script type="module" src="/documents-upload.js"></script>
    </section>
  );
}
