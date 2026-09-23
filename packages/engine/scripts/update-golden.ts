/**
 * Regenerates the `expected` block of every golden fixture from the current engine.
 *
 *   pnpm --filter @harbour/engine run fixtures:update
 *
 * The resulting diff is a formula change. Per §5.10 it must be reviewed by someone who has
 * done customs entries, and `CALC_VERSION` must be bumped if any money output moved.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeQuote } from '../src/index.js';
import type { QuoteInput } from '../src/types.js';

const dir = join(import.meta.dirname, '..', 'fixtures', 'quotes');
let changed = 0;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const path = join(dir, file);
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
    input: QuoteInput;
    expected: unknown;
  };
  const result = computeQuote(fixture.input);
  const next = JSON.stringify({ ...fixture, expected: result }, null, 2) + '\n';
  if (next !== readFileSync(path, 'utf8')) {
    writeFileSync(path, next);
    changed += 1;
    console.log(`updated ${file}`);
  }
}
console.log(`${changed} fixture(s) changed`);
