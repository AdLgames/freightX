import type { ReactNode } from 'react';
import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';
import type { Route } from './+types/root';
import stylesheet from './styles.css?url';

/** §1 non-negotiable: shown on every page and on every quote. */
export const DISCLAIMER =
  'Indicative figures only. Not a contractual rate. We are not a freight forwarder or customs agent.';

export const links: Route.LinksFunction = () => [{ rel: 'stylesheet', href: stylesheet }];

export const meta: Route.MetaFunction = () => [
  { title: 'Harbour — landed-cost calculator for UK importers' },
  {
    name: 'description',
    content:
      'Work out the fully landed cost per unit of an import into the UK: freight, duty, VAT and fees.',
  },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="site-header">
          <nav className="container" aria-label="Main">
            <Link to="/" className="brand">
              Harbour
            </Link>
            <Link to="/calculator">Landed-cost calculator</Link>
          </nav>
        </header>
        <main id="main" className="container">
          {children}
        </main>
        <footer className="site-footer">
          <div className="container">
            <p>{DISCLAIMER}</p>
            <p className="muted">Harbour is a working name. Phase 0 public preview.</p>
          </div>
        </footer>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Never leaks stack traces in production: React Router already sanitises server errors before
 * they reach the client outside development, and this boundary only renders a stack when Vite
 * says we are in dev.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let detail = 'Please try again in a moment. If it keeps happening, let us know.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Page not found' : `Error ${error.status}`;
    detail =
      error.status === 404
        ? 'The page you are looking for does not exist.'
        : error.statusText || detail;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  return (
    <section className="error-page">
      <h1>{title}</h1>
      <p>{detail}</p>
      {stack ? (
        <pre className="stack">
          <code>{stack}</code>
        </pre>
      ) : null}
      <p>
        <Link to="/">Back to the start</Link>
      </p>
    </section>
  );
}
