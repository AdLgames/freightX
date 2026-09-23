import { can, recordAudit } from '@harbour/db';
import type { CompanyMatch } from '@harbour/adapters';
import { Form, data } from 'react-router';
import type { Route } from './+types/app.settings.organisation';
import { CsrfInput } from '../components/csrf';
import { FieldError, FormBanner, Intent, StatusBadge, formatUtc } from '../components/settings-ui';
import { getApp } from '../services/app.server';
import { assertPermission, requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import { confirmCompany, readCompany, storeCompany } from '../services/settings/company.server';
import { identityDbError, readIdentity, saveIdentity } from '../services/settings/identity.server';
import { CURRENCIES, fieldErrors } from '../validators/common';
import {
  companyConfirmSchema,
  companySearchSchema,
  eoriFormSchema,
  organizationDetailsSchema,
  vatFormSchema,
} from '../validators/settings';

/**
 * Organisation settings (M2): details, the identity step (EORI, VAT — UX spec 1 and 2) and the
 * Companies House lookup (1b, ADR-0015). One route, several forms; the `intent` field picks the
 * handler. Everyone may look; OWNER/ADMIN may change (`org.tax_ids.edit`, `org.company.confirm`).
 *
 * EORI and VAT numbers are encrypted before they are stored and only their last four characters
 * are ever shown or audited. Verification runs in the worker; the page shows its status.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Organisation — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const { org, identity, company } = await withOrg(ctx, async (tx) => ({
    org: await tx.organization.findUniqueOrThrow({
      where: { id: ctx.org.id },
      select: { name: true, baseCurrency: true },
    }),
    identity: await readIdentity(tx, ctx.org.id),
    company: await readCompany(tx, ctx.org.id),
  }));
  return {
    org,
    identity,
    company,
    canEdit: can(ctx.role, 'org.tax_ids.edit'),
    canConfirmCompany: can(ctx.role, 'org.company.confirm'),
    companyLookupEnabled: app.settings.companiesHouse !== null,
    /** True when saved numbers will actually be verified (a worker can pick the job up). */
    verificationRuns: app.settings.jobs.backend === 'bullmq',
    currencies: CURRENCIES,
  };
};

type Intent =
  'details' | 'eori' | 'vat' | 'company.search' | 'company.confirm' | 'company.unincorporated';

export interface OrganisationActionData {
  intent: Intent;
  ok: boolean;
  message: string | null;
  errors: Record<string, string>;
  /** Company search results (intent company.search only). */
  matches?: CompanyMatch[];
  query?: string;
}

const respond = (body: OrganisationActionData, status = body.ok ? 200 : 400) =>
  data<OrganisationActionData>(body, { status });

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const intent = field(form!, 'intent');
  const now = new Date();

  switch (intent) {
    case 'details': {
      assertPermission(ctx, 'org.tax_ids.edit', request);
      const parsed = organizationDetailsSchema.safeParse({
        name: field(form!, 'name'),
        baseCurrency: field(form!, 'baseCurrency'),
      });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      await withOrg(ctx, async (tx) => {
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: ctx.org.id },
          select: { name: true, baseCurrency: true },
        });
        if (before.name === parsed.data.name && before.baseCurrency === parsed.data.baseCurrency) {
          return;
        }
        await tx.organization.update({ where: { id: ctx.org.id }, data: parsed.data });
        await recordAudit(tx, {
          organizationId: ctx.org.id,
          userId: ctx.user.id,
          action: 'org.update',
          targetType: 'Organization',
          targetId: ctx.org.id,
          // The name is user free text (§7.3); record what changed, not the value.
          metadata: {
            nameChanged: before.name !== parsed.data.name,
            baseCurrency: parsed.data.baseCurrency,
          },
        });
      });
      log.info('settings.org_details_saved', { orgId: ctx.org.id });
      return respond({ intent, ok: true, message: 'Organisation details saved.', errors: {} });
    }

    case 'eori':
    case 'vat': {
      assertPermission(ctx, 'org.tax_ids.edit', request);
      const keyProvider = app.settings.keyProvider;
      if (!keyProvider) {
        return respond(
          {
            intent,
            ok: false,
            message: 'Encryption is not configured on this server.',
            errors: {},
          },
          503,
        );
      }
      let patch;
      if (intent === 'eori') {
        const parsed = eoriFormSchema.safeParse({ eoriNumber: field(form!, 'eoriNumber') });
        if (!parsed.success) {
          return respond({
            intent,
            ok: false,
            message: null,
            errors: fieldErrors(parsed.error.issues),
          });
        }
        patch = { eoriNumber: parsed.data.eoriNumber };
      } else {
        const parsed = vatFormSchema.safeParse({
          vatRegistered: field(form!, 'vatRegistered'),
          vatNumber: field(form!, 'vatNumber'),
        });
        if (!parsed.success) {
          return respond({
            intent,
            ok: false,
            message: null,
            errors: fieldErrors(parsed.error.issues),
          });
        }
        patch = { vat: parsed.data };
      }
      let result;
      try {
        result = await withOrg(ctx, (tx) =>
          saveIdentity(
            tx,
            { organizationId: ctx.org.id, userId: ctx.user.id, keyProvider, now },
            patch,
          ),
        );
      } catch (err) {
        const errors = identityDbError(err);
        if (!errors) throw err;
        return respond({ intent, ok: false, message: null, errors });
      }
      if (!result.ok) return respond({ intent, ok: false, message: null, errors: result.errors });
      // Enqueue only after the transaction committed; a queue failure never fails the save.
      for (const queue of result.jobs)
        await app.settings.jobs.enqueue(queue, { organizationId: ctx.org.id });
      log.info('settings.identity_saved', {
        orgId: ctx.org.id,
        field: intent,
        changed: intent === 'eori' ? result.changed.eori : result.changed.vat,
        jobs: result.jobs,
      });
      const changed = intent === 'eori' ? result.changed.eori : result.changed.vat;
      const verifying = result.jobs.length > 0;
      return respond({
        intent,
        ok: true,
        message: !changed
          ? 'Nothing changed.'
          : verifying
            ? app.settings.jobs.backend === 'bullmq'
              ? 'Saved. We are checking it with HMRC; the status updates when the check completes.'
              : 'Saved. HMRC verification will run once the background worker is set up.'
            : 'Saved.',
        errors: {},
      });
    }

    case 'company.search': {
      assertPermission(ctx, 'org.company.confirm', request);
      const client = app.settings.companiesHouse;
      if (!client) {
        return respond(
          {
            intent,
            ok: false,
            message: 'Company lookup is not available on this server.',
            errors: {},
          },
          503,
        );
      }
      const parsed = companySearchSchema.safeParse({ query: field(form!, 'query') });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await client.searchCompanies(parsed.data.query);
      if (!result.ok) {
        log.warn('settings.company_search_failed', { orgId: ctx.org.id, reason: result.reason });
        return respond(
          {
            intent,
            ok: false,
            message:
              result.reason === 'UNAUTHORISED'
                ? 'Company lookup is not configured correctly on this server.'
                : 'We could not reach Companies House just now. Try again in a minute, or choose "sole trader or partnership".',
            errors: {},
          },
          503,
        );
      }
      log.info('settings.company_searched', { orgId: ctx.org.id, matches: result.matches.length });
      return respond({
        intent,
        ok: true,
        message: result.matches.length === 0 ? 'No companies matched that name.' : null,
        errors: {},
        matches: result.matches,
        query: parsed.data.query,
      });
    }

    case 'company.confirm': {
      assertPermission(ctx, 'org.company.confirm', request);
      const client = app.settings.companiesHouse;
      if (!client) {
        return respond(
          {
            intent,
            ok: false,
            message: 'Company lookup is not available on this server.',
            errors: {},
          },
          503,
        );
      }
      const parsed = companyConfirmSchema.safeParse({
        companyNumber: field(form!, 'companyNumber'),
      });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await withOrg(ctx, (tx) =>
        confirmCompany(
          tx,
          client,
          { organizationId: ctx.org.id, userId: ctx.user.id, now },
          parsed.data.companyNumber,
        ),
      );
      if (!result.ok) {
        log.warn('settings.company_confirm_failed', { orgId: ctx.org.id, reason: result.reason });
        return respond(
          {
            intent,
            ok: false,
            message:
              result.reason === 'NOT_FOUND'
                ? 'That company number was not found at Companies House.'
                : 'We could not confirm the company just now. Try again in a minute.',
            errors: {},
          },
          result.reason === 'NOT_FOUND' ? 400 : 503,
        );
      }
      log.info('settings.company_confirmed', { orgId: ctx.org.id });
      return respond({ intent, ok: true, message: 'Company record saved.', errors: {} });
    }

    case 'company.unincorporated': {
      assertPermission(ctx, 'org.company.confirm', request);
      await withOrg(ctx, (tx) =>
        storeCompany(tx, { organizationId: ctx.org.id, userId: ctx.user.id, now }, null),
      );
      log.info('settings.company_confirmed', { orgId: ctx.org.id, unincorporated: true });
      return respond({
        intent,
        ok: true,
        message: 'Saved: sole trader or partnership.',
        errors: {},
      });
    }

    default:
      return respond({ intent: 'details', ok: false, message: 'Unknown action.', errors: {} });
  }
};

export default function OrganisationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { org, identity, company, canEdit, canConfirmCompany } = loaderData;
  const result = (intent: Intent) => (actionData?.intent === intent ? actionData : null);
  const details = result('details');
  const eori = result('eori');
  const vat = result('vat');
  const search = result('company.search');
  const confirm = result('company.confirm') ?? result('company.unincorporated');

  return (
    <>
      <section aria-labelledby="details-title">
        <h2 id="details-title">Details</h2>
        {details?.message ? (
          <FormBanner tone={details.ok ? 'ready' : 'error'}>
            <p>{details.message}</p>
          </FormBanner>
        ) : null}
        <Form method="post">
          <CsrfInput />
          <Intent value="details" />
          <div className={`field${details?.errors.name ? ' has-error' : ''}`}>
            <label htmlFor="name">Organisation name</label>
            <FieldError id="name-error" message={details?.errors.name} />
            <input
              id="name"
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={120}
              defaultValue={org.name}
              disabled={!canEdit}
              aria-invalid={details?.errors.name ? true : undefined}
            />
          </div>
          <div className={`field${details?.errors.baseCurrency ? ' has-error' : ''}`}>
            <label htmlFor="baseCurrency">Base currency</label>
            <span className="hint">The currency your landed costs are reported in.</span>
            <FieldError id="baseCurrency-error" message={details?.errors.baseCurrency} />
            <select
              id="baseCurrency"
              name="baseCurrency"
              className="narrow"
              defaultValue={org.baseCurrency}
              disabled={!canEdit}
            >
              {loaderData.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {canEdit ? (
            <button type="submit" className="button">
              Save details
            </button>
          ) : (
            <p className="muted">Only owners and admins can change these details.</p>
          )}
        </Form>
      </section>

      <section aria-labelledby="eori-title">
        <h2 id="eori-title">EORI number</h2>
        <p>
          Current:{' '}
          {identity.eori.set ? (
            <>
              <span className="code">…{identity.eori.last4}</span>{' '}
              <StatusBadge status={identity.eori.status} />
              {identity.eori.verifiedAt ? (
                <span className="muted"> (checked {formatUtc(identity.eori.verifiedAt)})</span>
              ) : null}
            </>
          ) : (
            <span className="muted">not added yet</span>
          )}
        </p>
        {eori?.message ? (
          <FormBanner tone={eori.ok ? 'ready' : 'error'}>
            <p>{eori.message}</p>
          </FormBanner>
        ) : null}
        {canEdit ? (
          <Form method="post">
            <CsrfInput />
            <Intent value="eori" />
            <div className={`field${eori?.errors.eoriNumber ? ' has-error' : ''}`}>
              <label htmlFor="eoriNumber">What is your company&apos;s EORI number?</label>
              <span className="hint" id="eori-hint">
                GB or XI followed by 12 digits, for example GB123456789000. Don&apos;t have one?{' '}
                <a href="https://www.gov.uk/eori" rel="noreferrer">
                  Apply on GOV.UK
                </a>
                . You need this to import goods into the UK.
                {identity.eori.set ? ' Leave blank to remove the stored number.' : ''}
              </span>
              <FieldError id="eoriNumber-error" message={eori?.errors.eoriNumber} />
              <input
                id="eoriNumber"
                name="eoriNumber"
                type="text"
                inputMode="text"
                autoComplete="off"
                maxLength={20}
                placeholder="GB123456789000"
                aria-describedby={
                  eori?.errors.eoriNumber ? 'eori-hint eoriNumber-error' : 'eori-hint'
                }
                aria-invalid={eori?.errors.eoriNumber ? true : undefined}
              />
            </div>
            <button type="submit" className="button">
              Save EORI
            </button>
          </Form>
        ) : null}
      </section>

      <section aria-labelledby="vat-title">
        <h2 id="vat-title">VAT registration</h2>
        <p>
          Current:{' '}
          {identity.vat.registered ? (
            <>
              registered
              {identity.vat.set ? (
                <>
                  , VRN <span className="code">…{identity.vat.last4}</span>
                </>
              ) : null}{' '}
              <StatusBadge status={identity.vat.status} />
              {identity.vat.verifiedAt ? (
                <span className="muted"> (checked {formatUtc(identity.vat.verifiedAt)})</span>
              ) : null}
            </>
          ) : (
            <span className="muted">not VAT registered</span>
          )}
        </p>
        {vat?.message ? (
          <FormBanner tone={vat.ok ? 'ready' : 'error'}>
            <p>{vat.message}</p>
          </FormBanner>
        ) : null}
        {canEdit ? (
          <Form method="post">
            <CsrfInput />
            <Intent value="vat" />
            <fieldset className={`field radios${vat?.errors.vatRegistered ? ' has-error' : ''}`}>
              <legend>Are you VAT registered in the UK?</legend>
              <FieldError id="vatRegistered-error" message={vat?.errors.vatRegistered} />
              <div className="check">
                <input
                  type="radio"
                  id="vatRegistered-yes"
                  name="vatRegistered"
                  value="yes"
                  defaultChecked={identity.vat.registered}
                />
                <label htmlFor="vatRegistered-yes">Yes</label>
              </div>
              <div className="check">
                <input
                  type="radio"
                  id="vatRegistered-no"
                  name="vatRegistered"
                  value="no"
                  defaultChecked={!identity.vat.registered}
                />
                <label htmlFor="vatRegistered-no">No</label>
              </div>
            </fieldset>
            <div className={`field${vat?.errors.vatNumber ? ' has-error' : ''}`}>
              <label htmlFor="vatNumber">What is your VAT Registration Number (VRN)?</label>
              <span className="hint" id="vat-hint">
                GB followed by 9 digits (12 for a branch), for example GB123456782. A mismatch with
                HMRC&apos;s records is a warning, not a block.
                {identity.vat.set ? ' Leave blank to keep the stored number.' : ''}
              </span>
              <FieldError id="vatNumber-error" message={vat?.errors.vatNumber} />
              <input
                id="vatNumber"
                name="vatNumber"
                type="text"
                autoComplete="off"
                maxLength={20}
                placeholder="GB123456782"
                aria-describedby={vat?.errors.vatNumber ? 'vat-hint vatNumber-error' : 'vat-hint'}
                aria-invalid={vat?.errors.vatNumber ? true : undefined}
              />
            </div>
            <button type="submit" className="button">
              Save VAT registration
            </button>
          </Form>
        ) : null}
        {!loaderData.verificationRuns && canEdit ? (
          <p className="hint">
            HMRC checks run in the background worker, which is not connected on this server; new
            numbers stay &quot;pending&quot; until it is.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="company-title">
        <h2 id="company-title">Is your business a limited company?</h2>
        <p className="hint">
          We look your organisation up at Companies House. This only records what the register says;
          it changes nothing else in your workspace today.
        </p>
        <p>
          Current:{' '}
          {company.checkedAt === null ? (
            <span className="muted">not checked yet</span>
          ) : company.unincorporated ? (
            <>
              sole trader or partnership{' '}
              <span className="muted">(recorded {formatUtc(company.checkedAt)})</span>
            </>
          ) : (
            <>
              <strong>{company.name}</strong>, {company.companyNumber},{' '}
              {company.status ?? 'status unknown'}
              {company.type ? ` (${company.type})` : ''}{' '}
              <span className="muted">(checked {formatUtc(company.checkedAt)})</span>
            </>
          )}
        </p>
        {confirm?.message ? (
          <FormBanner tone={confirm.ok ? 'ready' : 'error'}>
            <p>{confirm.message}</p>
          </FormBanner>
        ) : null}
        {search?.message ? (
          <FormBanner tone={search.ok ? 'notice' : 'error'}>
            <p>{search.message}</p>
          </FormBanner>
        ) : null}
        {canConfirmCompany ? (
          <>
            {loaderData.companyLookupEnabled ? (
              <Form method="post" className="inline-fields">
                <CsrfInput />
                <Intent value="company.search" />
                <div className={`field${search?.errors.query ? ' has-error' : ''}`}>
                  <label htmlFor="query">Company name</label>
                  <FieldError id="query-error" message={search?.errors.query} />
                  <input
                    id="query"
                    name="query"
                    type="text"
                    maxLength={200}
                    defaultValue={search?.query ?? org.name}
                    aria-invalid={search?.errors.query ? true : undefined}
                  />
                </div>
                <button type="submit" className="button secondary">
                  Search Companies House
                </button>
              </Form>
            ) : (
              <p className="muted">Company lookup is not configured on this server.</p>
            )}
            {search?.matches && search.matches.length > 0 ? (
              <ul className="card-list">
                {search.matches.map((m) => (
                  <li key={m.companyNumber} className="card">
                    <Form method="post">
                      <CsrfInput />
                      <Intent value="company.confirm" />
                      <input type="hidden" name="companyNumber" value={m.companyNumber} />
                      <p>
                        Is this you? <strong>{m.name}</strong>, {m.companyNumber},{' '}
                        {m.status ?? 'status unknown'}
                        {m.type ? ` (${m.type})` : ''}
                      </p>
                      <button type="submit" className="button">
                        Yes, this is us
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            ) : null}
            <Form method="post">
              <CsrfInput />
              <Intent value="company.unincorporated" />
              <button type="submit" className="button secondary">
                I&apos;m a sole trader or partnership
              </button>
            </Form>
          </>
        ) : null}
      </section>
    </>
  );
}
