import { withOrg, type OrgContext } from '../auth.server';
import { builderInputToValues, toBuilderInput } from '../../validators/quote';
import { computeFromValues, loadBuilderOptions } from './builder.server';
import {
  builderInputOf,
  replaceQuote,
  type QuoteRecord,
  type QuoteWriteResult,
} from './quotes.server';

/**
 * Re-runs the pipeline for a saved quote from its stored builder input, with the CURRENT
 * catalogue values, exchange rates, freight rates and tariff (M4).
 *
 *   - `mode: 'draft'`   — "Update to current catalogue values": DRAFT stays DRAFT.
 *   - `mode: 'finalise'` — DRAFT → the engine's READY or INDICATIVE (§5.9).
 *
 * Only DRAFT rows are touched; an ACCEPTED quote never changes (the trigger backs this up).
 */
export type RecomputeResult =
  QuoteWriteResult | { ok: false; error: 'NO_INPUT' | 'INVALID'; message: string };

export const recomputeQuote = async (
  ctx: OrgContext,
  row: QuoteRecord,
  mode: 'draft' | 'finalise',
): Promise<RecomputeResult> => {
  const builderInput = builderInputOf(row);
  if (!builderInput) {
    return {
      ok: false,
      error: 'NO_INPUT',
      message: 'This quote has no stored builder inputs, so it cannot be recomputed.',
    };
  }
  const { options, products } = await loadBuilderOptions(
    ctx,
    builderInput.lines.map((l) => l.productId),
  );
  const computed = await computeFromValues(
    ctx,
    builderInputToValues(builderInput),
    products,
    options.lanes,
  );
  if (!computed.ok) return { ok: false, error: 'INVALID', message: computed.formError };
  const view = computed.outcome.view;
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  return withOrg(ctx, (tx) =>
    replaceQuote(
      tx,
      actor,
      row.id,
      {
        view,
        builderInput: toBuilderInput(computed.input),
        status: mode === 'finalise' ? view.quote.status : 'DRAFT',
      },
      { from: ['DRAFT'] },
    ),
  );
};
