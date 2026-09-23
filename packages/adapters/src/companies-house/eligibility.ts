/**
 * ADR-0015 finance gate, as a pure function: the trade finance module is offered only when the
 * company is `active` and is a private/public limited company or an LLP. Sole traders and general
 * partnerships (no Companies House record) are never eligible.
 *
 * The type codes below are the values the Companies House API is documented to return
 * (`company_type` in search results, `type` in the company profile). They MUST be confirmed
 * against the live API before the finance module ships — docs/decisions-needed.md (u). Unknown
 * codes are ineligible (fail closed).
 */
export const FINANCE_ELIGIBLE_COMPANY_TYPES = ['ltd', 'plc', 'llp'] as const;
export const FINANCE_ELIGIBLE_COMPANY_STATUS = 'active';

export interface CompanyGateInput {
  status: string | null | undefined;
  type: string | null | undefined;
}

export const isEligibleForFinance = (input: CompanyGateInput): boolean => {
  const status = input.status?.trim().toLowerCase();
  const type = input.type?.trim().toLowerCase();
  if (status !== FINANCE_ELIGIBLE_COMPANY_STATUS || !type) return false;
  return (FINANCE_ELIGIBLE_COMPANY_TYPES as readonly string[]).includes(type);
};
