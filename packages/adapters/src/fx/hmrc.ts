import { Decimal } from 'decimal.js';
import type { FxRateRecord } from './store.js';

/**
 * HMRC monthly exchange rates (§5.7 primary source).
 *
 * The UK Trade Tariff service republishes HMRC's monthly rates as CSV:
 *   https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_{YYYY}-{M}.csv
 * Columns (header names vary slightly between years, matched case-insensitively):
 *   Country/Territories, Currency, Currency Code, Currency Units per £1, Start Date, End Date
 * Rates are "units of foreign currency per £1", so rateToGbp = 1 / units.
 */
export const hmrcMonthlyCsvUrl = (year: number, month: number): string =>
  `https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_${year}-${month}.csv`;

const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

/** Accepts DD/MM/YYYY or YYYY-MM-DD; returns YYYY-MM-DD. */
const toIsoDate = (s: string): string | null => {
  const uk = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (uk) return `${uk[3]}-${uk[2]}-${uk[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
};

export interface HmrcParseResult {
  records: FxRateRecord[];
  skipped: Array<{ line: number; reason: string }>;
}

export const parseHmrcMonthlyCsv = (csv: string): HmrcParseResult => {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const headerLine = lines[0];
  if (!headerLine) throw new Error('HMRC CSV is empty');
  const header = splitCsvLine(headerLine).map((h) => h.toLowerCase());
  const col = (pred: (h: string) => boolean): number => header.findIndex(pred);
  const iCode = col((h) => h.includes('currency code') || h === 'code');
  const iUnits = col(
    (h) => h.includes('per £1') || h.includes('per gbp') || h.includes('units per'),
  );
  const iStart = col((h) => h.startsWith('start'));
  const iEnd = col((h) => h.startsWith('end'));
  if (iCode < 0 || iUnits < 0 || iStart < 0 || iEnd < 0) {
    throw new Error(`HMRC CSV header not recognised: ${headerLine}`);
  }
  const records: FxRateRecord[] = [];
  const skipped: HmrcParseResult['skipped'] = [];
  lines.slice(1).forEach((line, idx) => {
    const cells = splitCsvLine(line);
    const code = (cells[iCode] ?? '').toUpperCase();
    const units = cells[iUnits] ?? '';
    const validFrom = toIsoDate(cells[iStart] ?? '');
    const validTo = toIsoDate(cells[iEnd] ?? '');
    if (
      !/^[A-Z]{3}$/.test(code) ||
      !validFrom ||
      !validTo ||
      !/^\d+(\.\d+)?$/.test(units) ||
      units === '0'
    ) {
      skipped.push({ line: idx + 2, reason: `unparseable row: ${line.slice(0, 80)}` });
      return;
    }
    const rateToGbp = new Decimal(1)
      .div(new Decimal(units))
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
      .toString();
    records.push({ source: 'HMRC_MONTHLY', currency: code, rateToGbp, validFrom, validTo });
  });
  return { records, skipped };
};
