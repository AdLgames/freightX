/**
 * Email signups (Phase 0 gate: 50). Repository interface owned by the app; the Prisma-backed
 * implementation is wired in db.server.ts once `@harbour/db` lands.
 */
export interface EmailSignupRecord {
  email: string;
  source: string | null;
  createdAt: Date;
}

export interface EmailSignupRepository {
  /** Idempotent on email: returns `created: false` when it already existed. */
  add(record: EmailSignupRecord): Promise<{ created: boolean }>;
  count(): Promise<number>;
}

export class InMemoryEmailSignupRepository implements EmailSignupRepository {
  private readonly byEmail = new Map<string, EmailSignupRecord>();

  async add(record: EmailSignupRecord): Promise<{ created: boolean }> {
    if (this.byEmail.has(record.email)) return { created: false };
    this.byEmail.set(record.email, record);
    return { created: true };
  }

  async count(): Promise<number> {
    return this.byEmail.size;
  }
}
