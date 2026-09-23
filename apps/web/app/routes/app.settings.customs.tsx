import { can } from '@harbour/db';
import { Form, Link, data } from 'react-router';
import type { Route } from './+types/app.settings.customs';
import { CsrfInput } from '../components/csrf';
import { FieldError, FormBanner, formatUtc } from '../components/settings-ui';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import {
  customsProfileDbError,
  readCustomsProfile,
  saveCustomsProfile,
} from '../services/settings/customs-profile.server';
import { fieldErrors } from '../validators/common';
import { customsProfileSchema } from '../validators/settings';

/**
 * Customs profile wizard (M2; UX spec steps 2–4 with the corrected copy; ADR-0011). One form,
 * three steps as sections, progressive enhancement (every field is always in the markup; the
 * hints say which apply). OWNER/ADMIN edit (`org.tax_ids.edit`); others read.
 *
 * Corrected copy, verbatim from the spec: the FORWARDER pays HMRC and invoices you (we never act
 * as customs principal); the fee comes from the signed forwarder's terms; PVA changes when VAT
 * is paid, not what the goods cost; the EORI to authorise in CDS is the forwarder's; CDS
 * authority gates booking (Phase 2), not quoting.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Customs profile — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const profile = await withOrg(ctx, (tx) => readCustomsProfile(tx, ctx.org.id));
  return {
    profile,
    canEdit: can(ctx.role, 'org.tax_ids.edit'),
    forwarder: app.settings.forwarder,
    feeDefaults: app.pricing.brokerDefermentDefaults,
  };
};

export interface CustomsActionData {
  ok: boolean;
  message: string | null;
  errors: Record<string, string>;
}

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'org.tax_ids.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const log = requestLogger((await getApp()).logger, request);

  const parsed = customsProfileSchema.safeParse({
    usePva: field(form!, 'usePva'),
    paymentMethod: field(form!, 'paymentMethod'),
    brokerDefermentFeePct: field(form!, 'brokerDefermentFeePct'),
    brokerDefermentMinimumGbp: field(form!, 'brokerDefermentMinimumGbp'),
    danNumber: field(form!, 'danNumber'),
    cdsAuthorityConfirmed: field(form!, 'cdsAuthorityConfirmed'),
  });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('settings.customs_profile_invalid', {
      orgId: ctx.org.id,
      fields: Object.keys(errors),
    });
    return data<CustomsActionData>({ ok: false, message: null, errors }, { status: 400 });
  }

  let result;
  try {
    result = await withOrg(ctx, (tx) =>
      saveCustomsProfile(
        tx,
        { organizationId: ctx.org.id, userId: ctx.user.id, now: new Date() },
        parsed.data,
      ),
    );
  } catch (err) {
    // The 0003 CHECKs / PVA trigger are the backstop; translate, never 500.
    const errors = customsProfileDbError(err);
    if (!errors) throw err;
    log.info('settings.customs_profile_rejected', {
      orgId: ctx.org.id,
      fields: Object.keys(errors),
    });
    return data<CustomsActionData>({ ok: false, message: null, errors }, { status: 400 });
  }
  if (!result.ok) {
    return data<CustomsActionData>(
      { ok: false, message: null, errors: result.errors },
      { status: 400 },
    );
  }
  log.info('settings.customs_profile_saved', {
    orgId: ctx.org.id,
    changed: result.changed,
    paymentMethod: parsed.data.paymentMethod,
    usePva: parsed.data.usePva,
    cdsConfirmed: result.cdsConfirmed,
  });
  return data<CustomsActionData>({
    ok: true,
    message: result.changed ? 'Customs profile saved.' : 'Nothing changed.',
    errors: {},
  });
};

export default function CustomsProfileSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { profile, canEdit, forwarder, feeDefaults } = loaderData;
  const errors = actionData?.errors ?? {};
  const forwarderName = forwarder.name ?? '{forwarder to be confirmed}';
  const forwarderEori = forwarder.eori ?? '{forwarder to be confirmed}';
  const feeTerms =
    profile.brokerDefermentFeePct !== null || profile.brokerDefermentMinimumGbp !== null
      ? `${profile.brokerDefermentFeePct ?? '?'}% of the duty and VAT advanced, minimum £${profile.brokerDefermentMinimumGbp ?? '?'}`
      : feeDefaults.feePct !== null || feeDefaults.minimumGbp !== null
        ? `${feeDefaults.feePct ?? '?'}% of the duty and VAT advanced, minimum £${feeDefaults.minimumGbp ?? '?'}`
        : 'their signed terms (to be confirmed)';

  return (
    <>
      {actionData?.message ? (
        <FormBanner tone={actionData.ok ? 'ready' : 'error'}>
          <p>{actionData.message}</p>
        </FormBanner>
      ) : null}
      {!canEdit ? (
        <p className="muted">Only owners and admins can change the customs profile.</p>
      ) : null}
      <Form method="post">
        <CsrfInput />
        <fieldset disabled={!canEdit}>
          <legend>Step 2 — VAT cash flow</legend>
          {profile.vatRegistered && profile.vatNumberSet ? null : (
            <p className="hint">
              Postponed VAT accounting needs a UK VAT registration. Add your VRN under{' '}
              <Link to="/app/settings/organisation">Organisation</Link> first.
            </p>
          )}
          <p className="label">How do you want to handle import VAT?</p>
          <div className={`field radios${errors.usePva ? ' has-error' : ''}`}>
            <FieldError id="usePva-error" message={errors.usePva} />
            <div className="check">
              <input
                type="radio"
                id="usePva-on"
                name="usePva"
                value="on"
                defaultChecked={profile.usePva}
                aria-describedby="usePva-hint"
              />
              <label htmlFor="usePva-on">
                Account for it on my VAT return (postponed VAT accounting). Better for cash flow.
              </label>
            </div>
            <div className="check">
              <input
                type="radio"
                id="usePva-off"
                name="usePva"
                value=""
                defaultChecked={!profile.usePva}
              />
              <label htmlFor="usePva-off">Pay it at the border.</label>
            </div>
            <span className="hint" id="usePva-hint">
              PVA changes when VAT is paid, not what the goods cost. Quotes still show import VAT;
              it moves out of &quot;Cash needed at the border&quot; with the note &quot;Import VAT
              £X is accounted for on your VAT return.&quot;
            </span>
          </div>
        </fieldset>

        <fieldset disabled={!canEdit}>
          <legend>Step 3 — Duty payment routing</legend>
          <p className="label">When your goods arrive, how do you want to pay UK customs duty?</p>
          <div className={`field radios${errors.paymentMethod ? ' has-error' : ''}`}>
            <FieldError id="paymentMethod-error" message={errors.paymentMethod} />
            <div className="check">
              <input
                type="radio"
                id="pm-broker"
                name="paymentMethod"
                value="BROKER_DEFERMENT"
                defaultChecked={profile.paymentMethod === 'BROKER_DEFERMENT'}
                aria-describedby="pm-broker-hint"
              />
              <label htmlFor="pm-broker">Through our forwarding partner (default).</label>
            </div>
            <span className="hint" id="pm-broker-hint">
              Our partner forwarder pays HMRC from its deferment account to release your goods and
              invoices you. They charge an advancement fee of {feeTerms}.
            </span>
            <div className="check">
              <input
                type="radio"
                id="pm-own"
                name="paymentMethod"
                value="OWN_DEFERMENT"
                defaultChecked={profile.paymentMethod === 'OWN_DEFERMENT'}
              />
              <label htmlFor="pm-own">I have my own HMRC duty deferment account (DAN).</label>
            </div>
            <div className="check">
              <input
                type="radio"
                id="pm-cash"
                name="paymentMethod"
                value="CDS_CASH_ACCOUNT"
                defaultChecked={profile.paymentMethod === 'CDS_CASH_ACCOUNT'}
              />
              <label htmlFor="pm-cash">I have a pre-funded HMRC cash account.</label>
            </div>
          </div>

          <div className="subgroup">
            <p className="label">Forwarder fee terms (through our forwarding partner only)</p>
            <span className="hint">
              From the forwarder&apos;s signed terms. Leave blank if you do not know them yet; the
              quote then shows no advancement fee.
            </span>
            <div className="inline-fields">
              <div className={`field${errors.brokerDefermentFeePct ? ' has-error' : ''}`}>
                <label htmlFor="brokerDefermentFeePct">Fee (% of duty and VAT advanced)</label>
                <FieldError
                  id="brokerDefermentFeePct-error"
                  message={errors.brokerDefermentFeePct}
                />
                <input
                  id="brokerDefermentFeePct"
                  name="brokerDefermentFeePct"
                  type="text"
                  inputMode="decimal"
                  className="narrow"
                  maxLength={8}
                  defaultValue={profile.brokerDefermentFeePct ?? feeDefaults.feePct ?? ''}
                  aria-invalid={errors.brokerDefermentFeePct ? true : undefined}
                />
              </div>
              <div className={`field${errors.brokerDefermentMinimumGbp ? ' has-error' : ''}`}>
                <label htmlFor="brokerDefermentMinimumGbp">Minimum fee (GBP)</label>
                <FieldError
                  id="brokerDefermentMinimumGbp-error"
                  message={errors.brokerDefermentMinimumGbp}
                />
                <input
                  id="brokerDefermentMinimumGbp"
                  name="brokerDefermentMinimumGbp"
                  type="text"
                  inputMode="decimal"
                  className="narrow"
                  maxLength={12}
                  defaultValue={profile.brokerDefermentMinimumGbp ?? feeDefaults.minimumGbp ?? ''}
                  aria-invalid={errors.brokerDefermentMinimumGbp ? true : undefined}
                />
              </div>
            </div>
          </div>

          <div className="subgroup">
            <div className={`field${errors.danNumber ? ' has-error' : ''}`}>
              <label htmlFor="danNumber">Deferment account number (DAN) — own deferment only</label>
              <span className="hint" id="dan-hint">
                7 digits. Required when you pay from your own deferment account.
              </span>
              <FieldError id="danNumber-error" message={errors.danNumber} />
              <input
                id="danNumber"
                name="danNumber"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="narrow"
                maxLength={7}
                defaultValue={profile.danNumber ?? ''}
                aria-describedby={errors.danNumber ? 'dan-hint danNumber-error' : 'dan-hint'}
                aria-invalid={errors.danNumber ? true : undefined}
              />
            </div>
          </div>
        </fieldset>

        <fieldset disabled={!canEdit}>
          <legend>Step 4 — Authorise the forwarder (own deferment account only)</legend>
          <p>
            Before your goods can be cleared using your deferment account, HMRC requires you to
            authorise our forwarding partner to use it.
          </p>
          <ol>
            <li>
              Sign in to the Customs Declaration Service financial dashboard with your Government
              Gateway ID.
            </li>
            <li>Open &quot;Manage account authorities&quot;.</li>
            <li>
              Add our forwarding partner&apos;s EORI: <span className="code">{forwarderEori}</span>.
            </li>
          </ol>
          <p className="hint">
            This gates booking (Phase 2), not quoting. Quotes stay available in the meantime.
          </p>
          {profile.cdsAuthorityGranted ? (
            <p>
              Confirmed {formatUtc(profile.cdsAuthorityConfirmedAt)}. Untick and save to withdraw
              the confirmation.
            </p>
          ) : null}
          <div className={`field check${errors.cdsAuthorityConfirmed ? ' has-error' : ''}`}>
            <input
              type="checkbox"
              id="cdsAuthorityConfirmed"
              name="cdsAuthorityConfirmed"
              value="on"
              defaultChecked={profile.cdsAuthorityGranted}
            />
            <label htmlFor="cdsAuthorityConfirmed">
              I confirm I have authorised {forwarderName}&apos;s EORI in my CDS account.
            </label>
            <FieldError id="cdsAuthorityConfirmed-error" message={errors.cdsAuthorityConfirmed} />
          </div>
        </fieldset>

        {canEdit ? (
          <button type="submit" className="button">
            Save customs profile
          </button>
        ) : null}
      </Form>
    </>
  );
}
