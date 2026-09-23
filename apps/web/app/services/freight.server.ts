import { RateSheetFreightProvider, loadRateSheet } from '@harbour/adapters';
import { modeName, portName } from '../data/ports';
import { CALCULATOR_MODES, laneKey, type CalculatorMode } from '../validators/calculator';
import type { Logger } from './logger.server';
import { DEFAULT_RATE_SHEET, adaptersFile } from './paths.server';

export interface RateSheetMeta {
  version: string;
  placeholder: boolean;
  issuedAt: string;
  validUntil: string;
  path: string;
}

export interface LaneOption {
  key: string;
  origin: string;
  destination: string;
  mode: CalculatorMode;
  label: string;
  transitDays: number;
}

const isCalculatorMode = (m: string): m is CalculatorMode =>
  (CALCULATOR_MODES as readonly string[]).includes(m);

export const loadFreightProvider = (opts: {
  rateSheetPath: string | undefined;
  logger: Logger;
  now?: () => Date;
}): { provider: RateSheetFreightProvider; meta: RateSheetMeta; lanes: LaneOption[] } => {
  const path = opts.rateSheetPath ?? adaptersFile(...DEFAULT_RATE_SHEET);
  if (!path) {
    throw new Error(
      'Rate sheet not found: set RATE_SHEET_PATH or build @harbour/adapters (rate-sheets/v1.json).',
    );
  }
  const sheet = loadRateSheet(path);
  const provider = new RateSheetFreightProvider(sheet, opts.now);
  const meta: RateSheetMeta = {
    version: sheet.version,
    placeholder: sheet.placeholder,
    issuedAt: sheet.issuedAt,
    validUntil: sheet.validUntil,
    path,
  };
  const lanes: LaneOption[] = provider
    .lanes()
    .filter((l): l is typeof l & { mode: CalculatorMode } => isCalculatorMode(l.mode))
    .map((l) => ({
      key: laneKey(l.origin, l.destination, l.mode),
      origin: l.origin,
      destination: l.destination,
      mode: l.mode,
      label: `${portName(l.origin)} → ${portName(l.destination)} · ${modeName(l.mode)} (~${l.transitDays} days)`,
      transitDays: l.transitDays,
    }));
  opts.logger.info('freight.rate_sheet_loaded', {
    version: sheet.version,
    placeholder: sheet.placeholder,
    lanes: lanes.length,
    validUntil: sheet.validUntil,
  });
  if (sheet.placeholder) {
    opts.logger.warn('freight.placeholder_rates', {
      message: `${sheet.version} carries PLACEHOLDER figures; refresh from FBX + forwarder quotes before launch (§5.8).`,
    });
  }
  return { provider, meta, lanes };
};
