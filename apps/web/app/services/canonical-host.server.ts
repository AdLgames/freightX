import { redirect } from 'react-router';

/**
 * Canonical host (§7.1). In production `APP_URL` is the one origin the app answers on: magic
 * links are built from it and every workspace form is checked against it, so a visitor on any
 * other hostname — a Vercel deployment URL such as `freightx-abc123-team.vercel.app`, the
 * `freightx-git-main-…` branch alias, a bare `www.` variant once a domain exists — could browse
 * but never sign in ("This form has expired"). Instead of loosening the Origin check, every GET
 * for a document on a non-canonical host is sent to the same path on `APP_URL` with a 308.
 *
 * Never applied to: non-production (previews and local runs have no `APP_URL`), POSTs (the CSRF
 * check answers those), and the machine endpoints below, whose callers do not follow redirects.
 */
export const CANONICAL_HOST_EXEMPT_PREFIXES: readonly string[] = [
  '/healthz',
  '/api/cron/',
  '/webhooks/',
];

/** `/app.data?_routes=…` (a React Router data request) → `/app?…`, so the client navigates cleanly. */
const documentUrl = (url: URL): { pathname: string; search: string } => {
  const pathname =
    url.pathname === '/_root.data'
      ? '/'
      : url.pathname.endsWith('.data')
        ? url.pathname.slice(0, -'.data'.length) || '/'
        : url.pathname;
  const params = new URLSearchParams(url.search);
  params.delete('_routes');
  const search = params.toString();
  return { pathname, search: search ? `?${search}` : '' };
};

export const canonicalRedirect = (
  request: Request,
  appUrl: string | null,
  production: boolean,
): Response | null => {
  if (!production || !appUrl) return null;
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  let url: URL;
  let canonical: URL;
  try {
    url = new URL(request.url);
    canonical = new URL(appUrl);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() === canonical.host.toLowerCase()) return null;
  if (CANONICAL_HOST_EXEMPT_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;
  const { pathname, search } = documentUrl(url);
  return redirect(`${canonical.origin}${pathname}${search}`, 308);
};
