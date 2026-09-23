import { Form, Link, data, useSearchParams } from 'react-router';
import type { Route } from './+types/app.documents';
import { CsrfInput } from '../components/csrf';
import {
  DOCUMENT_TYPE_LABELS,
  documentStatusBadge,
  formatBytes,
  shortId,
} from '../components/document-labels';
import { requireOrgContext } from '../services/auth.server';
import {
  loadVault,
  requireDocumentStorage,
  type DocumentRow,
} from '../services/documents/documents.server';
import { vaultTabSchema } from '../validators/documents';

/**
 * Document vault (M5; docs/phase-1-workspace-ux.md "Documents"). Three sections, chosen with
 * `?tab=`: missing files per accepted quote (§6.1 needs a commercial invoice and packing list),
 * documents by quote, and organisation documents. Every row: type, sanitised name, size, status,
 * who uploaded it and when, download / verify / delete.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Documents — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'doc.download' });
  const { documents } = await requireDocumentStorage();
  const vault = await loadVault(ctx);
  const tab = vaultTabSchema.parse(new URL(request.url).searchParams.get('tab') ?? 'missing');
  return data(
    {
      ...vault,
      tab,
      canUpload: ctx.role !== 'VIEWER',
      scanner: documents.scanner.engine,
    },
    { headers: ctx.headers },
  );
};

const TABS = [
  { id: 'missing', label: 'Missing files' },
  { id: 'quotes', label: 'By quote' },
  { id: 'organisation', label: 'Organisation documents' },
] as const;

const when = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function StatusBadge({ row }: { row: DocumentRow }) {
  const badge = documentStatusBadge(row);
  return (
    <span className="doc-status">
      <span className={`status-pill doc-${badge.tone}`}>{badge.label}</span>
      {badge.detail ? <span className="hint">{badge.detail}</span> : null}
    </span>
  );
}

function DocumentTable({ rows, caption }: { rows: DocumentRow[]; caption: string }) {
  if (rows.length === 0) return <p className="muted">No documents yet.</p>;
  return (
    <div className="table-wrap">
      <table className="doc-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">File</th>
            <th scope="col" className="num">
              Size
            </th>
            <th scope="col">Status</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                {DOCUMENT_TYPE_LABELS[d.type]}
                {d.version > 1 ? <span className="muted"> v{d.version}</span> : null}
              </td>
              <td className="doc-name">{d.originalName}</td>
              <td className="num">{formatBytes(d.sizeBytes)}</td>
              <td>
                <StatusBadge row={d} />
              </td>
              <td>
                <span className="muted">{d.uploadedBy}</span>
                <br />
                {when(d.createdAt)}
              </td>
              <td className="doc-actions">
                {d.canDownload ? (
                  <a className="button secondary" href={`/app/documents/${d.id}/download`}>
                    Download
                  </a>
                ) : null}
                {d.canVerify ? (
                  <Form method="post" action={`/app/documents/${d.id}/verify`}>
                    <CsrfInput />
                    <button type="submit" className="button secondary">
                      Verify
                    </button>
                  </Form>
                ) : null}
                {d.canDelete ? (
                  <Form method="post" action={`/app/documents/${d.id}/delete`}>
                    <CsrfInput />
                    <button type="submit" className="button secondary">
                      Delete
                    </button>
                  </Form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Documents({ loaderData }: Route.ComponentProps) {
  const { tab, missing, quotes, organisation, acceptedQuoteCount, canUpload, scanner } = loaderData;
  const [params] = useSearchParams();
  const notice = params.get('notice');
  return (
    <>
      <div className="page-head">
        <h1>Documents</h1>
        {canUpload ? (
          <Link to="/app/documents/new" className="button">
            Upload a document
          </Link>
        ) : null}
      </div>
      {notice === 'uploaded' ? (
        <p className="banner notice" role="status">
          Upload received.{' '}
          {scanner === 'none'
            ? 'Type and size were checked; no virus scan is configured on this server.'
            : 'It is being scanned.'}
        </p>
      ) : null}
      {notice === 'deleted' ? (
        <p className="banner notice" role="status">
          Document deleted.
        </p>
      ) : null}
      {notice === 'verified' ? (
        <p className="banner notice" role="status">
          Document verified.
        </p>
      ) : null}
      {notice === 'rejected' ? (
        <p className="banner error" role="alert">
          The uploaded file did not match what was declared and was rejected.
        </p>
      ) : null}
      {scanner === 'none' ? (
        <p className="hint">
          No virus scanner is configured on this server: uploads get a type and size check only and
          stay &ldquo;Uploaded&rdquo;. Booking (Phase 2) needs documents that are Clean or Verified.
        </p>
      ) : null}

      <nav aria-label="Document sections" className="tabs">
        <ul>
          {TABS.map((t) => (
            <li key={t.id}>
              <Link
                to={`/app/documents?tab=${t.id}`}
                aria-current={t.id === tab ? 'page' : undefined}
              >
                {t.label}
                {t.id === 'missing' && missing.length > 0 ? (
                  <span className="tab-count">{missing.length}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === 'missing' ? (
        <section aria-labelledby="missing-title">
          <h2 id="missing-title">Missing files</h2>
          {acceptedQuoteCount === 0 ? (
            <p className="muted">
              Nothing to chase yet. Once a quote is accepted, its commercial invoice and packing
              list are listed here until they are uploaded.
            </p>
          ) : missing.length === 0 ? (
            <p className="muted">
              Every accepted quote has its commercial invoice and packing list.
            </p>
          ) : (
            <ul className="missing-files">
              {missing.map((m) => (
                <li key={`${m.quoteId}:${m.type}`}>
                  <span>
                    Quote {shortId(m.quoteId)}: awaiting{' '}
                    {DOCUMENT_TYPE_LABELS[m.type].toLowerCase()}
                    {m.rejected ? (
                      <span className="muted"> (the last upload was rejected)</span>
                    ) : null}
                  </span>
                  {canUpload ? (
                    <Link
                      className="button secondary"
                      to={`/app/documents/new?quoteId=${m.quoteId}&type=${m.type}`}
                    >
                      Upload
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === 'quotes' ? (
        <section aria-labelledby="quotes-title">
          <h2 id="quotes-title">By quote</h2>
          {quotes.length === 0 ? (
            <p className="muted">No quote has documents yet.</p>
          ) : (
            quotes.map((q) => (
              <section key={q.id} className="quote-group" aria-labelledby={`q-${q.id}`}>
                <h3 id={`q-${q.id}`}>
                  Quote {shortId(q.id)}{' '}
                  <span className="muted">
                    ({q.status.toLowerCase()}, {when(q.createdAt)})
                  </span>
                </h3>
                <DocumentTable
                  rows={q.documents}
                  caption={`Documents for quote ${shortId(q.id)}`}
                />
                {canUpload ? (
                  <p>
                    <Link to={`/app/documents/new?quoteId=${q.id}`}>
                      Upload a document for this quote
                    </Link>
                  </p>
                ) : null}
              </section>
            ))
          )}
        </section>
      ) : null}

      {tab === 'organisation' ? (
        <section aria-labelledby="org-title">
          <h2 id="org-title">Organisation documents</h2>
          <p className="hint">
            Records that apply to every shipment: your EORI confirmation, VAT certificate and the
            signed direct-representation authority for the forwarder.
          </p>
          <DocumentTable rows={organisation} caption="Organisation documents" />
          {canUpload ? (
            <p>
              <Link to="/app/documents/new?scope=ORGANISATION">
                Upload an organisation document
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
