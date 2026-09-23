import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * Locate files shipped inside `@harbour/adapters` (rate sheets, sample fixtures) from wherever
 * this code runs: `react-router dev` (source), vitest, or the built `build/server/index.js`.
 *
 * Strategy: resolve the package entry through Node's resolver (works through the pnpm workspace
 * symlink because `require.resolve` returns the real path), then walk up from `dist/`. As a
 * fallback for unusual layouts, look for `packages/adapters` above the current directory.
 */
export const adaptersPackageDir = (): string | null => {
  try {
    const entry = createRequire(import.meta.url).resolve('@harbour/adapters');
    // entry = <pkg>/dist/index.js
    const candidate = resolve(dirname(entry), '..');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // fall through
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'packages', 'adapters');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

export const adaptersFile = (...segments: string[]): string | null => {
  const dir = adaptersPackageDir();
  if (!dir) return null;
  const path = join(dir, ...segments);
  return existsSync(path) ? path : null;
};

export const DEFAULT_RATE_SHEET = ['rate-sheets', 'v1.json'] as const;
export const SAMPLE_FX_CSV = ['fixtures', 'fx', 'hmrc-monthly-sample.csv'] as const;
