// @harbour/db — Prisma schema, migrations (RLS + immutability triggers), tenant-scoped client,
// RBAC matrix and audit helper. See README.md.

export { createPrismaClient, disposePrismaClient, logLevelsFor } from './client.js';
export type { CreatePrismaClientOptions } from './client.js';

export {
  TENANT_MODELS,
  PASSTHROUGH_MODELS,
  TENANT_TABLES,
  isTenantModel,
  isPassthroughModel,
  TenantScopeError,
  UUID_RE,
  assertUuid,
  scopeField,
  scopeArgs,
  forOrganization,
  withOrgTransaction,
  withUserTransaction,
} from './tenancy.js';
export type {
  TenantModel,
  PassthroughModel,
  TenantScopeErrorCode,
  TenantClient,
  TenantTransactionClient,
  OrgTransactionOptions,
} from './tenancy.js';

export {
  ROLES,
  ACTIONS,
  RBAC_MATRIX,
  ForbiddenError,
  isRole,
  isAction,
  can,
  assertCan,
} from './rbac.js';
export type { Role, Action } from './rbac.js';

export { recordAudit } from './audit.js';
export type { AuditEntry, AuditWriter } from './audit.js';

// M2 — field encryption (§7.3), see crypto.ts and README "Field encryption".
export {
  CIPHERTEXT_VERSION,
  CIPHERTEXT_RE,
  DATA_KEY_BYTES,
  MASTER_KEY_BYTES,
  ORGANIZATION_ENCRYPTED_FIELDS,
  FieldCryptoError,
  EnvKeyProvider,
  parseMasterKey,
  generateMasterKey,
  generateDataKey,
  encryptField,
  decryptField,
  isCiphertext,
  last4,
  rewrapDataKey,
  resolveOrgDataKey,
  orgFieldCipher,
  createKeyProvider,
  prismaDataKeyStore,
  InMemoryDataKeyStore,
} from './crypto.js';
export type {
  KeyProvider,
  DataKeyStore,
  DataKeyStoreClient,
  OrgFieldCipher,
  KeyProviderChoice,
  FieldCryptoErrorCode,
  OrganizationEncryptedField,
} from './crypto.js';

export {
  PrismaTariffCacheStore,
  PrismaFxRateStore,
  PrismaEmailSignupRepository,
  TARIFF_CACHE_ANY_ORIGIN,
  SIGNUP_SOURCE_UNKNOWN,
  normalisedCommoditySchema,
  isoDateToUtcMidnight,
  utcIsoDate,
  startOfUtcDay,
  fxRecordToRow,
} from './stores.js';
export type { PrismaTariffCacheStoreOptions, EmailSignupInput } from './stores.js';

// M5: document vault
export { PrismaDocumentScanStore, DOCUMENT_SCAN_AUDIT_ACTION } from './documents.js';
// M9 — shipment tracking stores (ADR-0017). See src/tracking.ts.
export {
  PrismaTrackingStore,
  PrismaVesselPollStore,
  PrismaVesselStore,
  toActiveVesselRow,
  toPortRow,
  trackingOrgStore,
  withTrackingLookup,
  withTrackingSweep,
} from './tracking.js';
export type {
  ActiveVesselRow,
  PortRow,
  ShipmentDueForPoll,
  VesselPollPort,
  VesselPositionPatch,
} from './tracking.js';

// Generated client re-exports. `PrismaClient` is exported as a type only: construct instances via
// createPrismaClient() so there is one pool per process. `Role` (the Prisma enum) is exported as
// PrismaRole because the RBAC `Role` union above carries the same values.
export {
  Prisma,
  Plan,
  QuoteStatus,
  Incoterm,
  Mode,
  ShipmentStatus,
  DocumentType,
  DocumentStatus,
  DocumentScope, // M5
  PaymentMethod,
  VerificationStatus, // M2
  Role as PrismaRole,
  // M6
  SubscriptionStatus,
  // end M6
  // M3 (ADR-0012)
  PaymentTermType,
  BalanceTrigger,
  PayoutPartner,
  PayoutMethodType,
  ContainerSizeType, // M9
  VesselPollState, // M9
  PurchaseOrderStatus, // M7 (ADR-0013)
} from '../generated/client/index.js';
export type {
  PrismaClient,
  $Enums,
  Organization,
  CustomsProfile,
  User,
  Membership,
  MagicLinkToken,
  EmailSignup,
  Supplier,
  Product,
  Quote,
  QuoteLine,
  Shipment,
  ShipmentEvent,
  Document,
  AuditLog,
  OutboxEvent,
  TariffCache,
  FxRate,
  // M6
  StripeEvent,
  // end M6
  // M3 (ADR-0012)
  PickupLocation,
  PaymentTerms,
  PayoutMethod,
  Invitation, // M2
  Container, // M9
  ActiveVessel, // M9
  Port, // M9
  // M7 (ADR-0013)
  PurchaseOrder,
  PurchaseOrderItem,
  PoCounter,
} from '../generated/client/index.js';
