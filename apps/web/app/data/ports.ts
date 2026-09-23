/**
 * Human names for the UN/LOCODEs that appear in the Phase 0 rate sheet (§5.8). The rate sheet
 * is the allow-list; this map only decorates it. Unknown codes fall back to the code itself.
 */
export const PORT_NAMES: Readonly<Record<string, string>> = {
  CNSHA: 'Shanghai',
  CNNGB: 'Ningbo',
  CNSZX: 'Shenzhen',
  INNSA: 'Nhava Sheva (Mumbai)',
  TRIST: 'Istanbul',
  GBFXT: 'Felixstowe',
  GBSOU: 'Southampton',
  GBLGP: 'London Gateway',
  CNPVG: 'Shanghai Pudong',
  INBOM: 'Mumbai',
  GBLHR: 'London Heathrow',
};

export const portName = (locode: string): string => PORT_NAMES[locode] ?? locode;

export const MODE_NAMES: Readonly<Record<string, string>> = {
  SEA_LCL: 'Sea (LCL, shared container)',
  SEA_FCL: 'Sea (FCL, full container)',
  AIR: 'Air',
  ROAD: 'Road',
  RAIL: 'Rail',
};

export const modeName = (mode: string): string => MODE_NAMES[mode] ?? mode;
