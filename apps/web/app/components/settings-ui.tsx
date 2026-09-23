import type { ReactNode } from 'react';

/**
 * M2 — small presentational helpers shared by the settings routes (no state, no data access).
 * Dates are rendered in UTC from ISO strings so server and client markup agree (no locale or
 * time-zone dependent output during hydration).
 */

/** `2026-09-23T10:15:30.000Z` → `23 Sep 2026, 10:15 UTC`. */
export const formatUtc = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

export type VerificationStatusName = 'UNVERIFIED' | 'PENDING' | 'VALID' | 'INVALID' | 'ERROR';

const STATUS_LABEL: Record<VerificationStatusName, { text: string; tone: string }> = {
  UNVERIFIED: { text: 'Not verified', tone: 'muted' },
  PENDING: { text: 'Verification pending', tone: 'pending' },
  VALID: { text: 'Verified with HMRC', tone: 'valid' },
  INVALID: { text: 'Not recognised by HMRC', tone: 'invalid' },
  ERROR: { text: 'Could not verify yet', tone: 'error' },
};

export function StatusBadge({ status }: { status: VerificationStatusName }) {
  const { text, tone } = STATUS_LABEL[status];
  return <span className={`status-pill verification ${tone}`}>{text}</span>;
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span className="field-error" id={id}>
      {message}
    </span>
  );
}

export function FormBanner({
  tone,
  children,
}: {
  tone: 'ready' | 'error' | 'notice' | 'indicative';
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** The `intent` hidden field every multi-form settings page uses to route its POST. */
export function Intent({ value }: { value: string }) {
  return <input type="hidden" name="intent" value={value} />;
}
