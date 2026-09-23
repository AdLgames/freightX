import { describe, expect, it } from 'vitest';
import {
  STRIPE_EVENTS_QUEUE,
  STRIPE_EVENT_JOB_OPTIONS,
  StripeEventJobDataError,
  UnconfiguredStripeEventHandler,
  runStripeEventJob,
  type StripeEventHandlerPort,
  type StripeEventSummary,
} from '../src/jobs/stripe-events.js';
import { QUEUE_NAMES } from '../src/queues.js';
import { buildWiring, readEnv } from '../src/wiring.server.js';

const payload = {
  id: 'evt_test001',
  object: 'event' as const,
  type: 'customer.subscription.updated',
  created: 1790000000,
  livemode: false,
  data: { object: { id: 'sub_1', object: 'subscription' } },
};

describe('stripe-events job', () => {
  it('validates the job data and delegates the payload to the handler', async () => {
    const seen: unknown[] = [];
    const handler: StripeEventHandlerPort = {
      handle: async (p) => {
        seen.push(p);
        return { eventId: p.id, type: p.type, outcome: 'applied' } satisfies StripeEventSummary;
      },
    };
    const summary = await runStripeEventJob(
      { eventId: 'evt_test001', type: payload.type, payload },
      { handler },
    );
    expect(summary).toEqual({
      eventId: 'evt_test001',
      type: 'customer.subscription.updated',
      outcome: 'applied',
    });
    expect(seen).toHaveLength(1);
  });

  it('rejects malformed data and a mismatched event id without calling the handler', async () => {
    const handler: StripeEventHandlerPort = {
      handle: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(runStripeEventJob({ nope: true }, { handler })).rejects.toBeInstanceOf(
      StripeEventJobDataError,
    );
    await expect(
      runStripeEventJob({ eventId: 'evt_other', type: payload.type, payload }, { handler }),
    ).rejects.toThrow(/does not match/);
  });

  it('is event-driven: not one of the scheduled queues, kept failures for the dead-letter set', () => {
    expect((QUEUE_NAMES as readonly string[]).includes(STRIPE_EVENTS_QUEUE)).toBe(false);
    expect(STRIPE_EVENT_JOB_OPTIONS).toMatchObject({ attempts: 5, removeOnFail: false });
  });

  it('the default wiring fails every job loudly until a database-backed handler exists', async () => {
    const env = readEnv({});
    expect(env.STRIPE_EVENTS_CONSUMER).toBe('web');
    const wiring = buildWiring(env);
    expect(wiring.stripeEvents).toBeInstanceOf(UnconfiguredStripeEventHandler);
    await expect(
      wiring.runStripeEvent({ eventId: 'evt_test001', type: payload.type, payload }),
    ).rejects.toThrow(/not wired/);
  });
});
