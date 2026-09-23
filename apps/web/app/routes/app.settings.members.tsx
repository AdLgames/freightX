import { ROLES, can, type Role } from '@harbour/db';
// `ROLES` is only used in the loader: the client bundle must not pull @harbour/db (Prisma) in.
import { Form, data } from 'react-router';
import type { Route } from './+types/app.settings.members';
import { CsrfInput } from '../components/csrf';
import { FieldError, FormBanner, Intent, formatUtc } from '../components/settings-ui';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import {
  createInvitation,
  inviteUrl,
  listPendingInvitations,
  revokeInvitation,
} from '../services/settings/invitations.server';
import {
  canAssignRole,
  changeMemberRole,
  listMembers,
  removeMember,
} from '../services/settings/members.server';
import { fieldErrors } from '../validators/common';
import {
  changeRoleSchema,
  invitationIdSchema,
  inviteSchema,
  membershipIdSchema,
} from '../validators/settings';

/**
 * Members (M2; brief §7.2 "manage members"). Every member may see the list; OWNER/ADMIN
 * (`member.manage`) invite, change roles, remove members and revoke invitations. The rules
 * (owner-only for OWNER, no self-changes, last owner protected) live in members.server.ts.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Members — Harbour' }];

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Everything, including billing and other owners.',
  ADMIN: 'Everything except billing; can invite and manage members below owner.',
  MEMBER: 'Create and edit quotes, upload documents.',
  VIEWER: 'Read-only: view quotes and download documents.',
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const now = new Date();
  const { members, invitations } = await withOrg(ctx, async (tx) => ({
    members: await listMembers(tx, ctx.user.id),
    invitations: can(ctx.role, 'member.manage') ? await listPendingInvitations(tx, now) : [],
  }));
  return {
    members,
    invitations,
    role: ctx.role,
    canManage: can(ctx.role, 'member.manage'),
    roles: ROLES,
    assignableRoles: ROLES.filter((r) => canAssignRole(ctx.role, r)),
    roleHelp: ROLE_HELP,
  };
};

type Intent = 'invite' | 'role' | 'remove' | 'revoke';

export interface MembersActionData {
  intent: Intent;
  ok: boolean;
  message: string | null;
  errors: Record<string, string>;
}

const respond = (body: MembersActionData, status = body.ok ? 200 : 400) =>
  data<MembersActionData>(body, { status });

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'member.manage' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const intent = field(form!, 'intent');
  const now = new Date();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id, role: ctx.role, now };

  switch (intent) {
    case 'invite': {
      const parsed = inviteSchema.safeParse({
        email: field(form!, 'email'),
        role: field(form!, 'role'),
      });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const email = app.auth.email;
      if (!email) {
        return respond(
          {
            intent,
            ok: false,
            message: 'Email is not configured on this server, so invitations cannot be sent.',
            errors: {},
          },
          503,
        );
      }
      const created = await withOrg(ctx, (tx) => createInvitation(tx, actor, parsed.data));
      if (!created.ok) return respond({ intent, ok: false, message: created.message, errors: {} });
      const origin = app.auth.appUrl ?? new URL(request.url).origin;
      const link = inviteUrl(origin, ctx.org.id, created.secret);
      try {
        await email.send({
          to: parsed.data.email,
          // The subject is logged by the console transport; the organisation name (free text) stays in the body.
          subject: "You've been invited to an organisation on Harbour",
          text: [
            `You have been invited to join ${ctx.org.name} on Harbour as ${parsed.data.role.toLowerCase()}.`,
            '',
            'Accept the invitation with this link (it expires in 7 days):',
            link,
            '',
            "If you weren't expecting this, you can ignore it.",
          ].join('\n'),
        });
      } catch (err) {
        // The invitation row exists (and can be revoked); tell the inviter the email did not go.
        log.error('settings.invite_send_failed', {
          orgId: ctx.org.id,
          invitationId: created.invitationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return respond(
          {
            intent,
            ok: false,
            message:
              'The invitation was created but the email could not be sent. Revoke it and try again in a few minutes.',
            errors: {},
          },
          503,
        );
      }
      log.info('settings.invite_sent', {
        orgId: ctx.org.id,
        invitationId: created.invitationId,
        role: parsed.data.role,
      });
      return respond({ intent, ok: true, message: 'Invitation sent.', errors: {} });
    }

    case 'role': {
      const parsed = changeRoleSchema.safeParse({
        membershipId: field(form!, 'membershipId'),
        role: field(form!, 'role'),
      });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await withOrg(ctx, (tx) => changeMemberRole(tx, actor, parsed.data));
      if (!result.ok) return respond({ intent, ok: false, message: result.message, errors: {} });
      log.info('settings.member_role_changed', {
        orgId: ctx.org.id,
        membershipId: parsed.data.membershipId,
        role: parsed.data.role,
      });
      return respond({ intent, ok: true, message: 'Role updated.', errors: {} });
    }

    case 'remove': {
      const parsed = membershipIdSchema.safeParse({ membershipId: field(form!, 'membershipId') });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await withOrg(ctx, (tx) => removeMember(tx, actor, parsed.data));
      if (!result.ok) return respond({ intent, ok: false, message: result.message, errors: {} });
      log.info('settings.member_removed', {
        orgId: ctx.org.id,
        membershipId: parsed.data.membershipId,
      });
      return respond({
        intent,
        ok: true,
        message: 'Member removed. They have been signed out.',
        errors: {},
      });
    }

    case 'revoke': {
      const parsed = invitationIdSchema.safeParse({ invitationId: field(form!, 'invitationId') });
      if (!parsed.success) {
        return respond({
          intent,
          ok: false,
          message: null,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await withOrg(ctx, (tx) => revokeInvitation(tx, actor, parsed.data));
      if (!result.ok) return respond({ intent, ok: false, message: result.message, errors: {} });
      log.info('settings.invite_revoked', {
        orgId: ctx.org.id,
        invitationId: parsed.data.invitationId,
      });
      return respond({ intent, ok: true, message: 'Invitation revoked.', errors: {} });
    }

    default:
      return respond({ intent: 'invite', ok: false, message: 'Unknown action.', errors: {} });
  }
};

export default function MembersSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { members, invitations, canManage, roles, assignableRoles, roleHelp } = loaderData;
  const banner = actionData?.message ? (
    <FormBanner tone={actionData.ok ? 'ready' : 'error'}>
      <p>{actionData.message}</p>
    </FormBanner>
  ) : null;
  const inviteErrors = actionData?.intent === 'invite' ? actionData.errors : {};

  return (
    <>
      {banner}
      <section aria-labelledby="members-title">
        <h2 id="members-title">Members</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Since</th>
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId}>
                  <td>
                    {m.name ? (
                      <>
                        {m.name} <span className="muted">({m.email})</span>
                      </>
                    ) : (
                      m.email
                    )}
                    {m.isSelf ? <span className="muted"> — you</span> : null}
                  </td>
                  <td>{m.role}</td>
                  <td>{formatUtc(m.since)}</td>
                  {canManage ? (
                    <td>
                      {m.isSelf ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="member-actions">
                          <Form method="post" className="inline-fields">
                            <CsrfInput />
                            <Intent value="role" />
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <label htmlFor={`role-${m.membershipId}`} className="visually-hidden">
                              New role for {m.email}
                            </label>
                            <select
                              id={`role-${m.membershipId}`}
                              name="role"
                              className="narrow"
                              defaultValue={m.role}
                            >
                              {roles.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="button secondary">
                              Change role
                            </button>
                          </Form>
                          <Form method="post">
                            <CsrfInput />
                            <Intent value="remove" />
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <button type="submit" className="button secondary">
                              Remove
                            </button>
                          </Form>
                        </div>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>What each role can do</summary>
          <dl className="meta">
            {roles.map((r) => (
              <div key={r}>
                <dt>{r}</dt>
                <dd>{roleHelp[r]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>

      {canManage ? (
        <>
          <section aria-labelledby="invite-title">
            <h2 id="invite-title">Invite someone</h2>
            <Form method="post">
              <CsrfInput />
              <Intent value="invite" />
              <div className={`field${inviteErrors.email ? ' has-error' : ''}`}>
                <label htmlFor="email">Email address</label>
                <span className="hint">
                  They will get a link that works for 7 days and must sign in with this address.
                </span>
                <FieldError id="email-error" message={inviteErrors.email} />
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  required
                  maxLength={254}
                  aria-invalid={inviteErrors.email ? true : undefined}
                />
              </div>
              <div className={`field${inviteErrors.role ? ' has-error' : ''}`}>
                <label htmlFor="role">Role</label>
                <FieldError id="role-error" message={inviteErrors.role} />
                <select id="role" name="role" className="narrow" defaultValue="MEMBER">
                  {assignableRoles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="button">
                Send invitation
              </button>
            </Form>
          </section>

          <section aria-labelledby="pending-title">
            <h2 id="pending-title">Pending invitations</h2>
            {invitations.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((i) => (
                      <tr key={i.id}>
                        <td>{i.email}</td>
                        <td>{i.role}</td>
                        <td>{formatUtc(i.createdAt)}</td>
                        <td>
                          {formatUtc(i.expiresAt)}
                          {i.expired ? <span className="muted"> (expired)</span> : null}
                        </td>
                        <td>
                          <Form method="post">
                            <CsrfInput />
                            <Intent value="revoke" />
                            <input type="hidden" name="invitationId" value={i.id} />
                            <button type="submit" className="button secondary">
                              Revoke
                            </button>
                          </Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
