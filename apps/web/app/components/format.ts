/**
 * Display helpers that work on decimal STRINGS only (ADR-0003): no Number() round trip, so a
 * value like "1234567.89" is grouped without ever becoming a float.
 */
export const groupThousands = (decimal: string): string => {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [int = '0', frac] = unsigned.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
};

export const gbp = (decimal: string): string => `£${groupThousands(decimal)}`;

/** Pad a validated decimal string to at least 2 dp for display ("25" → "25.00"). String-only. */
export const pad2 = (decimal: string): string => {
  const [int = '0', frac = ''] = decimal.split('.');
  return `${int}.${frac.padEnd(2, '0')}`;
};

/** True for "0", "0.00", "-0.00" — string test, no float conversion. */
export const isZeroAmount = (decimal: string): boolean => /^-?0*(\.0*)?$/.test(decimal);

/** Whole-number count with thousands separators (quantities, units — not money). */
export const count = (n: number): string => groupThousands(String(n));

export const pct = (decimal: string | null): string =>
  decimal === null ? '—' : `${decimal.replace(/\.?0+$/, '')}%`;

export const isoDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};
