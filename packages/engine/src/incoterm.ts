import type { Incoterm } from './types.js';

/**
 * What the buyer pays and what enters the customs value under each incoterm (§5.5).
 * Kept as a data table so it can be reviewed line-by-line by a customs practitioner.
 */
export interface IncotermPlan {
  buyerPaysToBorderFreight: boolean;
  buyerPaysPostBorderFreight: boolean;
  buyerPaysOriginFees: 'ALWAYS' | 'IF_STATED' | 'NEVER';
  buyerPaysDestinationFees: boolean;
  buyerPaysClearance: boolean;
  /** Buyer may take out their own cargo insurance (not under CIF: seller already insured). */
  buyerInsuranceAllowed: boolean;
  /** Supplier price already includes freight to (at least) the UK port/airport. */
  supplierPriceIncludesFreight: boolean;
  /** Supplier price includes delivery to door → customs value must exclude the post-border leg. */
  supplierPriceIncludesToDoor: boolean;
  /** Supplier pays UK duty and import VAT (DDP). */
  supplierBearsDutyAndVat: boolean;
}

export const INCOTERM_PLANS: Readonly<Record<Incoterm, IncotermPlan>> = {
  EXW: {
    buyerPaysToBorderFreight: true,
    buyerPaysPostBorderFreight: true,
    buyerPaysOriginFees: 'ALWAYS',
    buyerPaysDestinationFees: true,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: false,
    supplierPriceIncludesToDoor: false,
    supplierBearsDutyAndVat: false,
  },
  FCA: {
    buyerPaysToBorderFreight: true,
    buyerPaysPostBorderFreight: true,
    buyerPaysOriginFees: 'IF_STATED',
    buyerPaysDestinationFees: true,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: false,
    supplierPriceIncludesToDoor: false,
    supplierBearsDutyAndVat: false,
  },
  FOB: {
    buyerPaysToBorderFreight: true,
    buyerPaysPostBorderFreight: true,
    buyerPaysOriginFees: 'IF_STATED',
    buyerPaysDestinationFees: true,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: false,
    supplierPriceIncludesToDoor: false,
    supplierBearsDutyAndVat: false,
  },
  CFR: {
    buyerPaysToBorderFreight: false,
    buyerPaysPostBorderFreight: true,
    buyerPaysOriginFees: 'NEVER',
    buyerPaysDestinationFees: true,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: true,
    supplierPriceIncludesToDoor: false,
    supplierBearsDutyAndVat: false,
  },
  CIF: {
    buyerPaysToBorderFreight: false,
    buyerPaysPostBorderFreight: true,
    buyerPaysOriginFees: 'NEVER',
    buyerPaysDestinationFees: true,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: false,
    supplierPriceIncludesFreight: true,
    supplierPriceIncludesToDoor: false,
    supplierBearsDutyAndVat: false,
  },
  DAP: {
    buyerPaysToBorderFreight: false,
    buyerPaysPostBorderFreight: false,
    buyerPaysOriginFees: 'NEVER',
    buyerPaysDestinationFees: false,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: true,
    supplierPriceIncludesToDoor: true,
    supplierBearsDutyAndVat: false,
  },
  DPU: {
    buyerPaysToBorderFreight: false,
    buyerPaysPostBorderFreight: false,
    buyerPaysOriginFees: 'NEVER',
    buyerPaysDestinationFees: false,
    buyerPaysClearance: true,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: true,
    supplierPriceIncludesToDoor: true,
    supplierBearsDutyAndVat: false,
  },
  DDP: {
    buyerPaysToBorderFreight: false,
    buyerPaysPostBorderFreight: false,
    buyerPaysOriginFees: 'NEVER',
    buyerPaysDestinationFees: false,
    buyerPaysClearance: false,
    buyerInsuranceAllowed: true,
    supplierPriceIncludesFreight: true,
    supplierPriceIncludesToDoor: true,
    supplierBearsDutyAndVat: true,
  },
};

export const incotermPlan = (incoterm: Incoterm): IncotermPlan => INCOTERM_PLANS[incoterm];
