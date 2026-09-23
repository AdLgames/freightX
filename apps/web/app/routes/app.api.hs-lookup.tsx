import type { Route } from './+types/app.api.hs-lookup';
import { requireOrgContext } from '../services/auth.server';
import { HS_INVALID_MESSAGE, hsLookupStatus } from '../services/catalogue/hs-lookup.server';
import { rateLimitedLookup } from '../services/catalogue/product-form.server';
import { requireCsrf } from '../services/csrf.server';
import { readForm } from '../services/request.server';
import { hsCode } from '../validators/common';

/**
 * POST /app/api/hs-lookup — the HS code field's live lookup (M3, UX spec "HS code field").
 *
 * Form-encoded body `hsCode=<6|8|10 digits>&_csrf=<token>`; JSON reply (`HsLookupResult`, or a
 * 429 with `Retry-After`). Same session, CSRF and 10-per-minute-per-user limit as the no-JS
 * "Check code" button — it is the same server function. Never cached.
 */

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });

export const loader = () =>
  json({ ok: false, reason: 'INVALID', message: 'POST a form with hsCode and _csrf.' }, 405, {
    Allow: 'POST',
  });

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const parsed = hsCode.safeParse(form?.get('hsCode') ?? '');
  if (!parsed.success) {
    return json({ ok: false, reason: 'INVALID', message: HS_INVALID_MESSAGE }, 400);
  }
  const state = await rateLimitedLookup(ctx, request, parsed.data);
  if (state.kind === 'rate-limited') {
    return json(
      {
        ok: false,
        reason: 'RATE_LIMITED',
        message: `Too many tariff lookups. Try again in ${state.retryAfterSeconds} seconds.`,
        retryAfterSeconds: state.retryAfterSeconds,
      },
      429,
      { 'Retry-After': String(state.retryAfterSeconds) },
    );
  }
  if (state.kind !== 'result') {
    return json({ ok: false, reason: 'UNAVAILABLE', message: 'Lookup did not run.' }, 503);
  }
  return json(state.result, hsLookupStatus(state.result));
};
