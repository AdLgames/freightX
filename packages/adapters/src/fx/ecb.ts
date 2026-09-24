import { Decimal } from 'decimal.js';
import type { FxRateRecord } from './store.js';

/**
 * ECB euro foreign exchange reference rates (§5.7 fallback):
 *   daily:   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml     (one day)
 *   history: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml  (last ~90 days)
 * Rates are "units per 1 EUR". GBP per unit of X = (GBP per EUR) / (X per EUR).
 * The XML is tiny and regular, so a targeted regex parse is used instead of an XML dependency.
 * Both files share the layout `<Cube time="YYYY-MM-DD"><Cube currency="USD" rate="…"/>…</Cube>`;
 * the history file simply repeats the dated block, newest first.
 */
export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const ECB_HISTORY_90D_URL =
  'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

export interface EcbParseResult {
  date: string;
  records: FxRateRecord[];
}

export interface EcbHistoryParseResult {
  /** Oldest first. */
  days: EcbParseResult[];
  /** Every day's records, flattened (oldest first). */
  records: FxRateRecord[];
}

const DATED_BLOCK_RE = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g;
const RATE_RE = /<Cube\s+currency="([A-Z]{3})"\s+rate="([\d.]+)"/g;

const parseDatedBlock = (date: string, body: string, validDays: number): EcbParseResult => {
  const perEur = new Map<string, Decimal>();
  const re = new RegExp(RATE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] && m[2]) perEur.set(m[1], new Decimal(m[2]));
  }
  const gbpPerEur = perEur.get('GBP');
  if (!gbpPerEur || gbpPerEur.lte(0)) throw new Error(`ECB XML: GBP rate missing for ${date}`);
  const validFrom = date;
  const validToDate = new Date(`${date}T00:00:00Z`);
  validToDate.setUTCDate(validToDate.getUTCDate() + validDays);
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

const datedBlocks = (xml: string): Array<{ date: string; body: string }> => {
  const out: Array<{ date: string; body: string }> = [];
  const re = new RegExp(DATED_BLOCK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] && m[2] !== undefined) out.push({ date: m[1], body: m[2] });
  }
  return out;
};

/** The daily file: one dated block (the first one, for a history file). */
export const parseEcbDailyXml = (
  xml: string,
  opts: { validDays?: number } = {},
): EcbParseResult => {
  const first = datedBlocks(xml)[0];
  if (!first) throw new Error('ECB XML: no <Cube time=...> found');
  return parseDatedBlock(first.date, first.body, opts.validDays ?? 7);
};

/**
 * The 90-day history file: every dated block, oldest first. A block without a GBP rate is
 * skipped rather than failing the whole file (it has never happened; belt and braces).
 */
export const parseEcbHistoryXml = (
  xml: string,
  opts: { validDays?: number } = {},
): EcbHistoryParseResult => {
  const blocks = datedBlocks(xml);
  if (blocks.length === 0) throw new Error('ECB XML: no <Cube time=...> found');
  const days: EcbParseResult[] = [];
  for (const b of blocks) {
    try {
      days.push(parseDatedBlock(b.date, b.body, opts.validDays ?? 7));
    } catch {
      // skip a malformed day; the others still load
    }
  }
  if (days.length === 0) throw new Error('ECB XML: no usable dated block');
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, records: days.flatMap((d) => d.records) };
};

/**
 * Which of a history file's records to write: every day the store does not have yet, plus the
 * `keepLatest` newest days (the ECB revises a day occasionally, and the newest day is the one a
 * daily job most wants to be sure of). `existingDates` are `validFrom` dates already stored.
 */
export const ecbRecordsToLoad = (
  history: EcbHistoryParseResult,
  existingDates: ReadonlySet<string>,
  keepLatest = 2,
): FxRateRecord[] => {
  const latest = new Set(history.days.slice(-keepLatest).map((d) => d.date));
  return history.days
    .filter((d) => latest.has(d.date) || !existingDates.has(d.date))
    .flatMap((d) => d.records);
};
