import { Form, Link } from 'react-router';
import type { Route } from './+types/_index';

const SIGNUP_MESSAGES: Record<string, { tone: 'ready' | 'error'; text: string }> = {
  ok: {
    tone: 'ready',
    text: 'Thanks — you are on the list. We will email you when the workspace opens.',
  },
  invalid: {
    tone: 'error',
    text: 'That email address does not look right. Please check it and try again.',
  },
  'rate-limited': {
    tone: 'error',
    text: 'Too many signups from your connection. Please try again in an hour.',
  },
};

export const meta: Route.MetaFunction = () => [
  { title: 'Harbour — know your landed cost before you commit to a supplier' },
];

export const loader = ({ request }: Route.LoaderArgs) => {
  const flag = new URL(request.url).searchParams.get('signup');
  return { signup: flag && flag in SIGNUP_MESSAGES ? flag : null };
};

export default function Index({ loaderData }: Route.ComponentProps) {
  const flash = loaderData.signup ? SIGNUP_MESSAGES[loaderData.signup] : undefined;
  return (
    <>
      <h1>Know your landed cost before you commit to a supplier</h1>
      <p className="lede">
        Harbour works out the fully landed cost per unit of an import into the UK — sea or air
        freight, UK duty from the live tariff, import VAT and the fees in between — so a one-person
        importing business can compare a supplier quote in minutes, not days.
      </p>
      <p>
        <Link to="/calculator" className="button">
          Try the landed-cost calculator
        </Link>
      </p>

      <h2>What it does today</h2>
      <ul>
        <li>
          Freight on the top lanes from China, India and Türkiye to Felixstowe, Southampton, London
          Gateway and Heathrow.
        </li>
        <li>
          Duty resolved from the UK Trade Tariff by commodity code, including preferences and
          anti-dumping duty where they apply.
        </li>
        <li>
          Customs value, duty base and VAT base built the way HMRC does it, branch by incoterm.
        </li>
        <li>Every quote says where each number came from and when it expires.</li>
      </ul>

      <h2>Coming next: a workspace</h2>
      <p>
        Save products and HS codes, keep suppliers and documents together, and re-quote in seconds.
        Leave your email and we will let you know when it opens.
      </p>

      {flash ? (
        <div className={`banner ${flash.tone}`} role="status">
          <p>{flash.text}</p>
        </div>
      ) : null}

      <Form method="post" action="/signup" className="signup-form">
        <div className="field">
          <label htmlFor="email">Email address</label>
          <span className="hint" id="email-hint">
            We will only use it to tell you when the workspace opens.
          </span>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            aria-describedby="email-hint"
          />
        </div>
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="website">Leave this field empty</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        <input type="hidden" name="source" value="landing" />
        <button type="submit" className="button">
          Keep me posted
        </button>
      </Form>
    </>
  );
}
