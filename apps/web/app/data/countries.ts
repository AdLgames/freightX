/**
 * Origin countries offered by the public calculator (ISO 3166-1 alpha-2). A deliberately short
 * list: the top sourcing countries for UK micro-importers plus the EU members most often quoted.
 * The validator allow-list is derived from this table.
 */
export const ORIGIN_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'CN', name: 'China' },
  { code: 'IN', name: 'India' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TH', name: 'Thailand' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'KH', name: 'Cambodia' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'KR', name: 'South Korea' },
  { code: 'JP', name: 'Japan' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'US', name: 'United States' },
  { code: 'MX', name: 'Mexico' },
  { code: 'BR', name: 'Brazil' },
  { code: 'EG', name: 'Egypt' },
  { code: 'MA', name: 'Morocco' },
];

export const ORIGIN_COUNTRY_CODES: readonly string[] = ORIGIN_COUNTRIES.map((c) => c.code);

export const countryName = (code: string): string =>
  ORIGIN_COUNTRIES.find((c) => c.code === code)?.name ?? code;
