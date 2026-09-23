/**
 * Progressive enhancement for the HS code field (M3). Runs in the browser only, attached from
 * `HsCodeField`'s effect after hydration; without JavaScript the same field falls back to the
 * "Check code" submit button and the server re-renders the result.
 *
 * CSP: this module is bundled and loaded through React Router's `<Scripts nonce>`, so there are
 * no inline scripts and no inline event handlers. The DOM is built with `createElement` /
 * `textContent` — never `innerHTML`.
 *
 * Behaviour: strip spaces and dots as the user types; on 6, 8 or 10 digits wait 400 ms then POST
 * the code (with the form's CSRF token) to `/app/api/hs-lookup`; show the official description,
 * the 10-digit candidates to pick from, or the error. Candidates are BUTTONS that put the chosen
 * code in the field and look it up — the page never picks one itself.
 */

import type { HsLookupResult } from '../../services/catalogue/hs-lookup.server';

export const HS_LOOKUP_ENDPOINT = '/app/api/hs-lookup';
const DEBOUNCE_MS = 400;
const VALID_LENGTHS = new Set([6, 8, 10]);

const cleanCode = (raw: string): string => raw.replace(/[\s.]/g, '');

const isLookupResult = (v: unknown): v is HsLookupResult =>
  typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface HsLookupOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
}

/**
 * Wires the field up. `root` is the field container (`[data-hs-field]`) holding the text input
 * (`input[name=hsCode]`), the "Check code" button (`[data-hs-check]`) and the live result
 * container (`[data-hs-live]`). Returns a cleanup function.
 */
export const attachHsLookup = (root: HTMLElement, opts: HsLookupOptions = {}): (() => void) => {
  const endpoint = opts.endpoint ?? HS_LOOKUP_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

  const input = root.querySelector<HTMLInputElement>('input[name="hsCode"]');
  const live = root.querySelector<HTMLElement>('[data-hs-live]');
  const check = root.querySelector<HTMLButtonElement>('[data-hs-check]');
  const serverResult = root.querySelector<HTMLElement>('[data-hs-server]');
  const form = root.closest('form');
  const csrf = form?.querySelector<HTMLInputElement>('input[name="_csrf"]');
  if (!input || !live || !form || !csrf) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let lastCode = '';

  const clear = () => {
    live.textContent = '';
    live.removeAttribute('data-status');
  };

  const show = (status: 'ok' | 'warn' | 'error' | 'pending', node: HTMLElement) => {
    clear();
    live.setAttribute('data-status', status);
    live.appendChild(node);
    // The server-rendered result (from a "Check code" round trip) is superseded by the live one.
    if (serverResult) serverResult.hidden = true;
  };

  const render = (result: HsLookupResult) => {
    if (!result.ok) {
      show(
        result.reason === 'UNAVAILABLE' ? 'warn' : 'error',
        el('p', 'hs-message', result.message),
      );
      return;
    }
    if (result.kind === 'COMMODITY') {
      const box = el('div', 'hs-verified');
      box.appendChild(el('p', 'hs-description', `✓ ${result.description}`));
      const facts: string[] = [];
      facts.push(`Third-country duty: ${result.thirdCountryDuty ?? 'not stated (needs review)'}`);
      facts.push(`VAT: ${result.vatRate ?? '20% assumed'}`);
      if (result.preferenceEligible) facts.push('preferential rates exist for some origins');
      box.appendChild(el('p', 'hint', facts.join(' · ')));
      show('ok', box);
      return;
    }
    const box = el('div', 'hs-candidates');
    box.appendChild(
      el(
        'p',
        'hint',
        `${result.code} maps to ${result.candidates.length === 1 ? 'one 10-digit code' : `${result.candidates.length} 10-digit codes`}. Choose the one that describes your goods — we never pick for you.`,
      ),
    );
    const list = el('ul', 'hs-candidate-list');
    for (const c of result.candidates) {
      const item = el('li', null);
      const button = el('button', 'button secondary hs-candidate', `Use ${c.code}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        input.value = c.code;
        input.focus();
        void lookup(c.code);
      });
      item.appendChild(button);
      const text = [c.description, c.thirdCountryDuty ? `duty ${c.thirdCountryDuty}` : null]
        .filter(Boolean)
        .join(' — ');
      if (text) item.appendChild(el('span', 'hs-candidate-text', ` ${text}`));
      list.appendChild(item);
    }
    box.appendChild(list);
    show('warn', box);
  };

  const lookup = async (code: string): Promise<void> => {
    controller?.abort();
    controller = new AbortController();
    lastCode = code;
    show('pending', el('p', 'hint', 'Checking the UK tariff…'));
    const body = new URLSearchParams({ hsCode: code, _csrf: csrf.value });
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (code !== lastCode) return;
      if (res.status === 429) {
        const retry = res.headers.get('retry-after');
        show(
          'warn',
          el(
            'p',
            'hs-message',
            `Too many tariff lookups. Try again in ${retry ?? 'a few'} seconds, or save the product unverified.`,
          ),
        );
        return;
      }
      const json: unknown = await res.json();
      if (!isLookupResult(json)) throw new Error('Unexpected response');
      render(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (code !== lastCode) return;
      show(
        'warn',
        el(
          'p',
          'hs-message',
          'The code could not be checked right now. You can save the product unverified and check it later.',
        ),
      );
    }
  };

  const onInput = () => {
    const cleaned = cleanCode(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    if (timer) clearTimeout(timer);
    if (cleaned === '') {
      clear();
      return;
    }
    if (!/^\d+$/.test(cleaned) || cleaned.length > 10 || cleaned.length === 9) {
      show('error', el('p', 'hs-message', 'Enter 6, 8 or 10 digits.'));
      return;
    }
    if (!VALID_LENGTHS.has(cleaned.length)) {
      clear();
      return;
    }
    timer = setTimeout(() => {
      void lookup(cleaned);
    }, debounceMs);
  };

  const onCheck = (event: Event) => {
    event.preventDefault();
    const cleaned = cleanCode(input.value);
    if (!VALID_LENGTHS.has(cleaned.length) || !/^\d+$/.test(cleaned)) {
      show('error', el('p', 'hs-message', 'Enter 6, 8 or 10 digits.'));
      return;
    }
    if (timer) clearTimeout(timer);
    void lookup(cleaned);
  };

  input.addEventListener('input', onInput);
  check?.addEventListener('click', onCheck);

  return () => {
    input.removeEventListener('input', onInput);
    check?.removeEventListener('click', onCheck);
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
};
