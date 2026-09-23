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

export const pct = (decimal: string | null): string =>
  decimal === null ? '—' : `${decimal.replace(/\.?0+$/, '')}%`;

export const isoDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};
