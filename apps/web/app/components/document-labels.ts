/**
 * Document vault vocabulary shared by server and client code (no Node imports here: route
 * components render these labels). `DOCUMENT_TYPES` mirrors the Prisma `DocumentType` enum, which
 * is additive only (§4 migration rules).
 */
export const DOCUMENT_TYPES = [
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'BILL_OF_LADING',
  'AIRWAY_BILL',
  'CERTIFICATE_OF_ORIGIN',
  'INSURANCE_CERT',
  'OTHER',
  'EORI_CONFIRMATION',
  'VAT_CERTIFICATE',
  'REPRESENTATION_AUTHORITY',
] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/** Records that apply to every shipment (docs/phase-1-workspace-ux.md "Organisation documents"). */
export const ORGANISATION_DOCUMENT_TYPES = [
  'EORI_CONFIRMATION',
  'VAT_CERTIFICATE',
  'REPRESENTATION_AUTHORITY',
  'OTHER',
] as const satisfies readonly DocumentTypeValue[];

export const QUOTE_DOCUMENT_TYPES = [
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'BILL_OF_LADING',
  'AIRWAY_BILL',
  'CERTIFICATE_OF_ORIGIN',
  'INSURANCE_CERT',
  'OTHER',
] as const satisfies readonly DocumentTypeValue[];

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentTypeValue, string>> = {
  COMMERCIAL_INVOICE: 'Commercial invoice',
  PACKING_LIST: 'Packing list',
  BILL_OF_LADING: 'Bill of lading',
  AIRWAY_BILL: 'Air waybill',
  CERTIFICATE_OF_ORIGIN: 'Certificate of origin',
  INSURANCE_CERT: 'Insurance certificate',
  OTHER: 'Other',
  EORI_CONFIRMATION: 'EORI confirmation',
  VAT_CERTIFICATE: 'VAT certificate',
  REPRESENTATION_AUTHORITY: 'Direct-representation authority',
};

export type DocumentStatusValue = 'UPLOADED' | 'SCANNING' | 'CLEAN' | 'REJECTED' | 'VERIFIED';

export interface StatusBadge {
  label: string;
  tone: 'neutral' | 'pending' | 'ok' | 'bad';
  detail: string | null;
}

/**
 * Status badge text. "Uploaded" with `scanResult = 'not_scanned'` means the type and size were
 * checked but NO virus scan ran (phase-1-build-plan: the fallback must not be presented as one).
 */
export const documentStatusBadge = (d: {
  status: DocumentStatusValue;
  scanResult: string | null;
  rejectedReason: string | null;
}): StatusBadge => {
  switch (d.status) {
    case 'UPLOADED':
      return d.scanResult === 'not_scanned'
        ? {
            label: 'Uploaded',
            tone: 'neutral',
            detail: 'Type and size checked. Not virus-scanned.',
          }
        : { label: 'Uploaded', tone: 'neutral', detail: 'Waiting for the upload to finish.' };
    case 'SCANNING':
      return { label: 'Scanning', tone: 'pending', detail: null };
    case 'CLEAN':
      return { label: 'Clean', tone: 'ok', detail: 'Virus scan passed.' };
    case 'VERIFIED':
      return {
        label: 'Verified',
        tone: 'ok',
        detail: 'Virus scan passed and checked by a person.',
      };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'bad', detail: rejectedReasonText(d.rejectedReason) };
  }
};

export const rejectedReasonText = (reason: string | null): string => {
  switch (reason ?? '') {
    case 'TYPE_MISMATCH':
      return 'The file content does not match its type.';
    case 'MALWARE_FOUND':
      return 'The virus scanner flagged this file.';
    case 'SIZE_MISMATCH':
      return 'The uploaded size did not match what was declared.';
    case 'TOO_LARGE':
      return 'The file is larger than 25 MB.';
    case 'EMPTY':
      return 'The file is empty.';
    case 'OBJECT_MISSING':
      return 'The upload never arrived.';
    case 'UNSUPPORTED_TYPE':
      return 'That file type is not accepted.';
    default:
      return 'Rejected.';
  }
};

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** "Quote 1a2b3c4d" — the first block of the UUID, enough to tell quotes apart in a list. */
export const shortId = (id: string): string => id.split('-')[0] ?? id.slice(0, 8);
