import { Decimal } from 'decimal.js';
import type { FxRateRecord } from './store.js';

/**
 * ECB euro foreign exchange reference rates (§5.7 fallback):
 *   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 * Rates are "units per 1 EUR". GBP per unit of X = (GBP per EUR) / (X per EUR).
 * The XML is tiny and regular, so a targeted regex parse is used instead of an XML dependency.
 */
export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export interface EcbParseResult {
  date: string;
  records: FxRateRecord[];
}

export const parseEcbDailyXml = (
  xml: string,
  opts: { validDays?: number } = {},
): EcbParseResult => {
  const dateMatch = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"/.exec(xml);
  if (!dateMatch?.[1]) throw new Error('ECB XML: no <Cube time=...> found');
  const date = dateMatch[1];
  const perEur = new Map<string, Decimal>();
  const re = /<Cube\s+currency="([A-Z]{3})"\s+rate="([\d.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] && m[2]) perEur.set(m[1], new Decimal(m[2]));
  }
  const gbpPerEur = perEur.get('GBP');
  if (!gbpPerEur || gbpPerEur.lte(0)) throw new Error('ECB XML: GBP rate missing');
  const validFrom = date;
  const validToDate = new Date(`${date}T00:00:00Z`);
  validToDate.setUTCDate(validToDate.getUTCDate() + (opts.validDays ?? 7));
  const validTo = validToDate.toISOString().slice(0, 10);
  const records: FxRateRecord[] = [
    {
      source: 'ECB',
      currency: 'EUR',
      rateToGbp: gbpPerEur.toDecimalPlaces(6).toString(),
      validFrom,
      validTo,
    },
  ];
  for (const [ccy, rate] of perEur) {
    if (ccy === 'GBP' || rate.lte(0)) continue;
    records.push({
      source: 'ECB',
      currency: ccy,
      rateToGbp: gbpPerEur.div(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toString(),
      validFrom,
      validTo,
    });
  }
  return { date, records };
};
