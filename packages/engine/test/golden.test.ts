import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeQuote } from '../src/index.js';
import type { ComputeResult, QuoteInput } from '../src/types.js';

interface Fixture {
  name: string;
  notes: string;
  input: QuoteInput;
  expected: ComputeResult | null;
}

const dir = join(import.meta.dirname, '..', 'fixtures', 'quotes');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('golden fixtures (§5.10)', () => {
  it('has at least 15 scenarios (sprint 1 target)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture;
    it(`${file}: ${fixture.notes.slice(0, 60)}…`, () => {
      expect(
        fixture.expected,
        `fixture ${file} has no expected block — run fixtures:update`,
      ).not.toBeNull();
      const actual = computeQuote(fixture.input);
      expect(actual).toEqual(fixture.expected);
    });
  }
});
