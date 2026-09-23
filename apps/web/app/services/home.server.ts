import type { PaymentMethod } from '@harbour/db';

/**
 * Home "Action required" banner (docs/phase-1-workspace-ux.md, Home). Per the corrected spec these
 * block BOOKING (Phase 2), not quoting, so the banner informs and links to Settings; it does not
 * gate anything in the workspace. Returns copy and links only — never the EORI or any value.
 */
export interface ActionItem {
  id: 'eori_missing' | 'cds_authority_missing';
  text: string;
  href: string;
}

export interface HomeActionInput {
  eoriNumber: string | null;
  customsProfile: { paymentMethod: PaymentMethod; cdsAuthorityGranted: boolean } | null;
}

export const homeActions = (input: HomeActionInput): ActionItem[] => {
  const items: ActionItem[] = [];
  if (input.eoriNumber === null || input.eoriNumber.trim() === '') {
    items.push({
      id: 'eori_missing',
      text: 'Add your EORI number — you need it before booking',
      href: '/app/settings',
    });
  }
  if (
    input.customsProfile?.paymentMethod === 'OWN_DEFERMENT' &&
    !input.customsProfile.cdsAuthorityGranted
  ) {
    items.push({
      id: 'cds_authority_missing',
      text: 'Authorise our forwarding partner to use your duty deferment account in CDS — you need it before booking',
      href: '/app/settings',
    });
  }
  return items;
};
