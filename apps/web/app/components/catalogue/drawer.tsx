import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * The catalogue's right-hand panel (UX spec: "a right-hand drawer, not a wizard"). It is an
 * ordinary server-rendered section that the list layout places beside the table on wide screens
 * and below it on narrow ones (styles.css `.catalogue`), so it needs no JavaScript to open,
 * close or submit.
 */
export function Drawer({
  title,
  closeTo,
  children,
}: {
  title: string;
  closeTo: string;
  children: ReactNode;
}) {
  return (
    <aside className="drawer" aria-labelledby="drawer-title">
      <div className="drawer-head">
        <h2 id="drawer-title">{title}</h2>
        <Link to={closeTo} className="drawer-close">
          Close
        </Link>
      </div>
      {children}
    </aside>
  );
}
