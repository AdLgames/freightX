/**
 * Request helpers. `react-router-serve` passes no load context, so the client address has to
 * come from the reverse proxy's headers (Fly, Railway, Cloudflare all set one). Behind no proxy
 * every client shares the "unknown" bucket — acceptable for local dev, wrong for production,
 * which is why the README says to deploy behind a proxy that sets these.
 *
 * The IP is used only as a rate-limit subject (hashed) and is never logged.
 */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

const looksLikeIp = (s: string): boolean => IPV4.test(s) || (s.includes(':') && IPV6.test(s));

export const clientIp = (request: Request): string => {
  const h = request.headers;
  const direct = h.get('fly-client-ip') ?? h.get('cf-connecting-ip') ?? h.get('x-real-ip');
  if (direct && looksLikeIp(direct.trim())) return direct.trim();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (looksLikeIp(first)) return first;
  }
  return 'unknown';
};

/** Reject bodies that are far larger than any legitimate form post (defence in depth). */
export const MAX_FORM_BYTES = 64 * 1024;

export const readForm = async (request: Request): Promise<FormData | null> => {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_FORM_BYTES) return null;
  const type = request.headers.get('content-type') ?? '';
  if (
    !type.startsWith('application/x-www-form-urlencoded') &&
    !type.startsWith('multipart/form-data')
  ) {
    return null;
  }
  try {
    return await request.formData();
  } catch {
    return null;
  }
};
