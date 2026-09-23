import { Link } from 'react-router';
import type { Route } from './+types/app.settings.audit';
import { formatUtc } from '../components/settings-ui';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { readAuditPage } from '../services/settings/audit.server';
import { auditPageSchema } from '../validators/settings';

/**
 * Audit log (M2; brief §9 "audit log entry for any state-changing action"). OWNER/ADMIN only
 * (`audit.view`). Read-only, paginated, newest first. Actor names/emails are resolved for the
 * screen here; they are never written into the log itself.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Audit log — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'audit.view' });
  const page = auditPageSchema.parse(new URL(request.url).searchParams.get('page') ?? '1');
  return withOrg(ctx, (tx) => readAuditPage(tx, page));
};

export default function AuditLog({ loaderData }: Route.ComponentProps) {
  const { rows, page, pages, entryCount } = loaderData;
  return (
    <section aria-labelledby="audit-title">
      <h2 id="audit-title">Audit log</h2>
      <p className="muted">
        {entryCount} {entryCount === 1 ? 'entry' : 'entries'}. Page {page} of {pages}. Times are
        UTC.
      </p>
      {rows.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Who</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatUtc(r.at)}</td>
                  <td>
                    <span className="code">{r.action}</span>
                  </td>
                  <td>{r.actor.label}</td>
                  <td>
                    {r.targetType} <span className="muted code">{r.targetId.slice(0, 8)}</span>
                  </td>
                  <td>{r.metadata ? <span className="code">{r.metadata}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Audit log pages" className="pager">
        {page > 1 ? (
          <Link to={`?page=${page - 1}`}>Newer</Link>
        ) : (
          <span className="muted">Newer</span>
        )}{' '}
        {page < pages ? (
          <Link to={`?page=${page + 1}`}>Older</Link>
        ) : (
          <span className="muted">Older</span>
        )}
      </nav>
    </section>
  );
}
