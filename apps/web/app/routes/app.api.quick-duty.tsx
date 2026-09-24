import type { Route } from './+types/app.api.quick-duty';
import { requireOrgContext } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { quickDutyStatus, runQuickDuty } from '../services/quotes/quick-duty.server';
import { readForm } from '../services/request.server';
import { QUICK_DUTY_FIELDS } from '../validators/quote';

/**
 * POST /app/api/quick-duty — the Home quick duty check as JSON (M4). Form-encoded body
 * `hsCode`, `invoiceValueGbp`, `originCountry`, optional `preferenceClaimed`, plus `_csrf`.
 * Same session, CSRF, tariff cache and 10-per-minute-per-user limit as the Home form (it is the
 * same server function, `runQuickDuty`). Never cached; nothing is saved.
 */

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

export const loader = () =>
  json(
    {
      kind: 'invalid',
      errors: { _form: 'POST a form with hsCode, invoiceValueGbp, originCountry and _csrf.' },
    },
    405,
    {
      Allow: 'POST',
    },
  );

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const values: Record<string, string> = {};
  for (const f of QUICK_DUTY_FIELDS) {
    const v = form?.get(f);
    if (typeof v === 'string') values[f] = v.slice(0, 200);
  }
  const result = await runQuickDuty(ctx, request, values);
  return json(
    result,
    quickDutyStatus(result),
    result.kind === 'rate-limited' ? { 'Retry-After': String(result.retryAfterSeconds) } : {},
  );
};
