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
  PaymentMethod,
  Role as PrismaRole,
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
} from '../generated/client/index.js';
