import { data } from 'react-router';
import { z } from 'zod';

/**
 * A thrown, user-facing error page: `throw pageError(403, 'Title', 'What to do')`. The root
 * ErrorBoundary recognises the body (`pageErrorSchema`) and renders the title and message with the
 * right status, so auth and workspace guards never have to render markup themselves.
 *
 * Shared by server and client (the boundary parses it), so no `.server` suffix and no secrets.
 */
export const pageErrorSchema = z.object({
  kind: z.literal('harbour.page-error'),
  title: z.string().max(200),
  message: z.string().max(1000),
  /** Developer hint, shown only when set; callers set it outside production only. */
  hint: z.string().max(1000).nullable(),
});
export type PageErrorBody = z.infer<typeof pageErrorSchema>;

export const pageError = (
  status: number,
  title: string,
  message: string,
  hint: string | null = null,
) =>
  data<PageErrorBody>(
    { kind: 'harbour.page-error', title, message, hint },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
