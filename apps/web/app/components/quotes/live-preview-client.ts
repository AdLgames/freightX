/**
 * Progressive enhancement for the quote builder (M4). Runs in the browser only, attached from the
 * builder component's effect after hydration. Without JavaScript the same form falls back to the
 * "Recalculate" submit button and a full-page re-render.
 *
 * CSP: bundled by React Router and loaded through `<Scripts nonce>`; no inline scripts, no inline
 * event handlers, no `innerHTML`. The module never renders the result itself: it debounces the
 * form's changes and hands the form to `submit`, which posts it to `?preview=1` (a React Router
 * fetcher); React renders the JSON that comes back into the breakdown column.
 *
 * It also applies a supplier's defaults when the supplier select changes: the chosen `<option>`
 * carries `data-incoterm` and `data-port`, which set the incoterm radio and the first lane from
 * that port — the same thing the server does for the no-JS "Apply supplier defaults" button.
 */

export const PREVIEW_DEBOUNCE_MS = 500;

/** Fields that do not change the computation (the "Add from catalogue" row). */
const IGNORED_FIELDS = new Set(['addProductId', 'addQuantity', '_csrf', 'intent']);

export interface LivePreviewOptions {
  submit: (form: HTMLFormElement) => void;
  debounceMs?: number;
}

const fieldName = (target: EventTarget | null): string | null => {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.name;
  }
  return null;
};

/** Set the incoterm radio and a lane from the chosen supplier's `data-*` defaults. */
export const applySupplierOption = (form: HTMLFormElement, option: HTMLOptionElement): void => {
  const incoterm = option.dataset.incoterm;
  if (incoterm) {
    const radio = form.querySelector<HTMLInputElement>(
      `input[name="incoterm"][value="${incoterm}"]`,
    );
    if (radio) radio.checked = true;
  }
  const port = option.dataset.port;
  const lane = form.querySelector<HTMLSelectElement>('select[name="lane"]');
  if (port && lane) {
    const current = lane.options[lane.selectedIndex];
    const same = Array.from(lane.options).find(
      (o) =>
        o.dataset.origin === port &&
        (!current ||
          (o.dataset.mode === current.dataset.mode &&
            o.dataset.destination === current.dataset.destination)),
    );
    const any = Array.from(lane.options).find((o) => o.dataset.origin === port);
    const pick = same ?? any;
    if (pick) lane.value = pick.value;
  }
};

/** Wires the builder form up. Returns a cleanup function. */
export const attachLivePreview = (
  form: HTMLFormElement,
  opts: LivePreviewOptions,
): (() => void) => {
  const debounceMs = opts.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      opts.submit(form);
    }, debounceMs);
  };

  const onChange = (event: Event) => {
    const name = fieldName(event.target);
    if (name === null || IGNORED_FIELDS.has(name)) return;
    if (name === 'supplierId' && event.type === 'change') {
      const select = event.target as HTMLSelectElement;
      const option = select.options[select.selectedIndex];
      if (option && option.value !== '') applySupplierOption(form, option);
    }
    schedule();
  };

  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  return () => {
    form.removeEventListener('input', onChange);
    form.removeEventListener('change', onChange);
    if (timer) clearTimeout(timer);
  };
};
