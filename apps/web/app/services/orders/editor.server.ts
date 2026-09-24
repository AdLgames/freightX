import { data } from 'react-router';
import {
  addItemSchema,
  orderFieldErrors,
  readOrderForm,
  type OrderFormValues,
  type OrderIntent,
  type RawItem,
} from '../../validators/order';
import { withOrg, type OrgContext } from '../auth.server';
import { orderTotals } from './schedule';

/**
 * Shared server logic of the purchase-order editor routes (`/app/orders/new`,
 * `/app/orders/:id/edit`, M7): the option lists, the no-JS intents (add/remove an item, apply
 * supplier defaults, recalculate) and the totals shown next to the form. The routes only decide
 * whether to create or replace a row. No JavaScript is needed: every button is a submit.
 */

export interface SupplierOption {
  id: string;
  name: string;
  defaultIncoterm: string | null;
  defaultCurrency: string | null;
  defaultPickupLocationId: string | null;
  hasPaymentTerms: boolean;
  archived: boolean;
}

export interface PickupOption {
  id: string;
  supplierId: string;
  name: string;
  port: string;
  isDefault: boolean;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  supplierId: string | null;
  unitValue: string;
  currency: string;
  archived: boolean;
}

export interface EditorOptions {
  suppliers: SupplierOption[];
  pickups: PickupOption[];
  products: ProductOption[];
}

/**
 * Everything the editor page needs. `includeIds` keeps archived products / the archived supplier
 * that an existing draft still references selectable (new lines cannot add them).
 */
export const loadEditorOptions = async (
  ctx: OrgContext,
  include: { productIds?: readonly string[]; supplierId?: string | null } = {},
): Promise<EditorOptions> => {
  const productIds = include.productIds ?? [];
  const { suppliers, products } = await withOrg(ctx, async (tx) => {
    const [suppliers, products] = await Promise.all([
      tx.supplier.findMany({
        where: {
          OR: [{ archivedAt: null }, ...(include.supplierId ? [{ id: include.supplierId }] : [])],
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          defaultIncoterm: true,
          defaultCurrency: true,
          archivedAt: true,
          paymentTerms: { select: { id: true } },
          pickupLocations: {
            select: { id: true, name: true, closestPortCode: true, isDefault: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      }),
      tx.product.findMany({
        where: {
          OR: [
            { archivedAt: null },
            ...(productIds.length ? [{ id: { in: [...productIds] } }] : []),
          ],
        },
        orderBy: [{ sku: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          sku: true,
          name: true,
          supplierId: true,
          unitValue: true,
          currency: true,
          archivedAt: true,
        },
      }),
    ]);
    return { suppliers, products };
  });
  return {
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      defaultIncoterm: s.defaultIncoterm,
      defaultCurrency: s.defaultCurrency,
      defaultPickupLocationId: s.pickupLocations.find((p) => p.isDefault)?.id ?? null,
      hasPaymentTerms: s.paymentTerms !== null,
      archived: s.archivedAt !== null,
    })),
    pickups: suppliers.flatMap((s) =>
      s.pickupLocations.map((p) => ({
        id: p.id,
        supplierId: s.id,
        name: p.name,
        port: p.closestPortCode,
        isDefault: p.isDefault,
      })),
    ),
    products: products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      supplierId: p.supplierId,
      unitValue: p.unitValue.toFixed(4),
      currency: p.currency,
      archived: p.archivedAt !== null,
    })),
  };
};

/** A blank form (optionally pre-set to a supplier's defaults). */
export const defaultValues = (
  options: EditorOptions,
  supplierId: string | null = null,
): OrderFormValues => {
  const values: OrderFormValues = {
    scalars: {
      supplierId: '',
      pickupLocationId: '',
      currency: 'USD',
      incoterm: 'FOB',
      expectedShipMonth: '',
      notes: '',
      poNumber: '',
      addProductId: '',
      addQuantity: '',
    },
    items: [],
  };
  const supplier = options.suppliers.find((s) => s.id === supplierId);
  return supplier ? applySupplierDefaults(values, supplier) : values;
};

/** Currency, incoterm and default pickup location from the supplier (ADR-0013). */
export const applySupplierDefaults = (
  values: OrderFormValues,
  supplier: SupplierOption,
): OrderFormValues => {
  const scalars: Record<string, string> = { ...values.scalars, supplierId: supplier.id };
  if (supplier.defaultIncoterm) scalars.incoterm = supplier.defaultIncoterm;
  if (supplier.defaultCurrency) scalars.currency = supplier.defaultCurrency;
  scalars.pickupLocationId = supplier.defaultPickupLocationId ?? '';
  return { scalars, items: values.items };
};

/**
 * "Add from catalogue": the unit cost defaults to the product's catalogue value. A product priced
 * in another currency than the order is refused here with a clear message (and again on save).
 */
export const addItem = (
  values: OrderFormValues,
  options: EditorOptions,
): { values: OrderFormValues; errors: Record<string, string> } => {
  const parsed = addItemSchema.safeParse({
    addProductId: values.scalars.addProductId,
    addQuantity: values.scalars.addQuantity,
  });
  if (!parsed.success) return { values, errors: orderFieldErrors(parsed.error.issues) };
  const product = options.products.find((p) => p.id === parsed.data.addProductId);
  if (!product) {
    return { values, errors: { addProductId: 'Choose a product from your catalogue.' } };
  }
  if (product.currency !== values.scalars.currency) {
    return {
      values,
      errors: {
        addProductId: `${product.sku} is priced in ${product.currency}; this order is in ${values.scalars.currency || 'no currency yet'}. Change the order currency first, or edit the product.`,
      },
    };
  }
  const items: RawItem[] = values.items.map((l) => ({ ...l }));
  const existing = items.findIndex((l) => l.productId === product.id);
  if (existing >= 0) {
    // Same product again: add to its quantity rather than duplicating the line.
    const was = Number(items[existing]!.quantity) || 0;
    items[existing]!.quantity = String(was + parsed.data.addQuantity);
  } else {
    items.push({
      productId: product.id,
      quantity: String(parsed.data.addQuantity),
      unitCost: product.unitValue,
    });
  }
  return {
    values: { scalars: { ...values.scalars, addProductId: '', addQuantity: '' }, items },
    errors: {},
  };
};

export const removeItem = (values: OrderFormValues, index: number): OrderFormValues => ({
  scalars: values.scalars,
  items: values.items.filter((_, i) => i !== index),
});

/** Which intent a submission carries; a "Remove" button (`removeItem=<i>`) wins over the field. */
export const readIntent = (form: FormData | null): { intent: OrderIntent; index: number } => {
  const remove = form?.get('removeItem');
  if (typeof remove === 'string' && /^\d{1,2}$/.test(remove)) {
    return { intent: 'remove-item', index: Number(remove) };
  }
  const raw = form?.get('intent');
  const intents: readonly string[] = ['recalculate', 'add-item', 'apply-supplier', 'save'];
  return {
    intent: typeof raw === 'string' && intents.includes(raw) ? (raw as OrderIntent) : 'recalculate',
    index: -1,
  };
};

/** Reads the form and applies the structural intents; the caller validates/saves afterwards. */
export const applyIntent = (
  form: FormData | null,
  options: EditorOptions,
): { intent: OrderIntent; values: OrderFormValues; errors: Record<string, string> } => {
  const { intent, index } = readIntent(form);
  let values = readOrderForm(form);
  let errors: Record<string, string> = {};
  if (intent === 'add-item') ({ values, errors } = addItem(values, options));
  if (intent === 'remove-item') values = removeItem(values, index);
  if (intent === 'apply-supplier') {
    const supplier = options.suppliers.find((s) => s.id === values.scalars.supplierId);
    if (supplier) values = applySupplierDefaults(values, supplier);
  }
  return { intent, values, errors };
};

/** Line totals for display from raw values: '—' for a line that does not parse yet. */
export interface TotalsView {
  lines: Array<string | null>;
  totalGoodsValue: string;
  /** Every line parsed; otherwise the total covers the valid lines only. */
  complete: boolean;
}

const QTY = /^\d{1,7}$/;
const COST = /^\d{1,15}(\.\d{1,4})?$/;

export const totalsView = (values: OrderFormValues): TotalsView => {
  const valid: Array<{ quantity: number; unitCost: string }> = [];
  const index: number[] = [];
  values.items.forEach((l, i) => {
    const q = l.quantity.trim();
    const c = l.unitCost.trim();
    if (QTY.test(q) && Number(q) >= 1 && COST.test(c)) {
      valid.push({ quantity: Number(q), unitCost: c });
      index.push(i);
    }
  });
  const totals = orderTotals(valid);
  const lines: Array<string | null> = values.items.map(() => null);
  index.forEach((i, k) => {
    lines[i] = totals.lines[k]?.lineTotal ?? null;
  });
  return {
    lines,
    totalGoodsValue: totals.totalGoodsValue,
    complete: valid.length === values.items.length,
  };
};

export interface EditorActionData {
  values: OrderFormValues;
  errors: Record<string, string>;
  /** A non-field problem shown above the form. */
  formError: string | null;
}

export const editorReply = (
  partial: Partial<EditorActionData> & { values: OrderFormValues },
  status = 200,
) => data<EditorActionData>({ errors: {}, formError: null, ...partial }, { status });
