import { createContext, useContext, type ReactNode } from 'react';

/**
 * CSRF synchroniser token for mutating forms (§7.1). A layout that has a session puts the token in
 * context (`<CsrfProvider token={loaderData.csrfToken}>`, done by the /app layout and onboarding);
 * every `<Form method="post">` inside renders `<CsrfInput />`, and the action calls
 * `requireCsrf(request, form, ctx.session)` (services/csrf.server.ts).
 *
 * Must match `CSRF_FIELD` in csrf.server.ts (a client module cannot import that file).
 */
export const CSRF_FIELD_NAME = '_csrf';

const CsrfContext = createContext<string | null>(null);

export function CsrfProvider({ token, children }: { token: string; children: ReactNode }) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

/** Hidden `_csrf` field. Throws when rendered outside a `CsrfProvider` (a bug, not a user error). */
export function CsrfInput() {
  const token = useContext(CsrfContext);
  if (token === null) throw new Error('<CsrfInput/> rendered outside <CsrfProvider>');
  return <input type="hidden" name={CSRF_FIELD_NAME} value={token} />;
}
