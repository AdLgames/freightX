import { DollarSign, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { Treasury, TreasuryPair } from '../../services/fx-treasury.server';

/**
 * Home "Live treasury" (docs/design-system.md, Home): GBP/USD and GBP/EUR tiles from the ECB
 * reference rates with the week's move. Green = the pound strengthened (each £ buys more when
 * paying suppliers), red = weakened. Shows the rate alone while the history is shorter than a
 * week, and a plain notice until the FX refresh has run at all. Quotes are unaffected: they price
 * with the HMRC monthly rate, which this card deliberately does not show.
 */
const TrendIcon = ({ direction }: { direction: TreasuryPair['direction'] }) => {
  if (direction === 'stronger') return <TrendingUp className="icon" aria-hidden="true" />;
  if (direction === 'weaker') return <TrendingDown className="icon" aria-hidden="true" />;
  return <Minus className="icon" aria-hidden="true" />;
};

const trendLabel = (p: TreasuryPair): string => {
  if (!p.changePct || !p.direction) return 'no 7-day history yet';
  const word =
    p.direction === 'stronger' ? 'stronger' : p.direction === 'weaker' ? 'weaker' : 'flat';
  return `${p.changePct}% over 7 days, pound ${word}`;
};

export function TreasuryCard({ treasury }: { treasury: Treasury }) {
  return (
    <section className="card treasury" aria-labelledby="treasury-title">
      <div className="card-head">
        <h2 id="treasury-title">Live treasury</h2>
        <DollarSign className="icon muted" aria-hidden="true" />
      </div>
      {treasury.pairs.length === 0 ? (
        <p className="muted">
          Live rates appear once the FX refresh has run. Quotes keep using the HMRC monthly rate.
        </p>
      ) : (
        <>
          <ul className="treasury-tiles">
            {treasury.pairs.map((p) => (
              <li key={p.pair} className="treasury-tile">
                <p className="stat-label">{p.pair.replace('/', ' / ')}</p>
                <p className="treasury-rate">
                  {p.rate}
                  <span
                    className={`treasury-trend${p.direction ? ` ${p.direction}` : ''}`}
                    title={trendLabel(p)}
                    aria-label={trendLabel(p)}
                  >
                    <TrendIcon direction={p.direction} />
                  </span>
                </p>
                <p className={`treasury-change${p.direction ? ` ${p.direction}` : ''}`}>
                  {p.changePct ? `${p.changePct}% over 7 days` : 'no 7-day history yet'}
                </p>
              </li>
            ))}
          </ul>
          <p className="muted small treasury-foot">
            ECB reference rates{treasury.asOf ? ` · ${treasury.asOf}` : ''}. Green: the pound
            strengthened, so each £ buys more when you pay suppliers.
          </p>
        </>
      )}
    </section>
  );
}
