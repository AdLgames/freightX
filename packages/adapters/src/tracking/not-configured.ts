import type {
  MilestoneProvider,
  PollResult,
  PositionProvider,
  SubscribeRequest,
  SubscribeResult,
  VesselPosition,
  WebhookParseResult,
} from './types.js';

/**
 * Placeholder providers (same pattern as `NotConfiguredScheduleProvider`, ADR-0010). The product
 * stays useful without them: shipments and containers are created, milestones are entered by
 * hand (`source = MANUAL`), and the UI says "Tracking not configured". Nothing here ever
 * pretends to have data.
 */
export const NOT_CONFIGURED = 'NOT_CONFIGURED';

export class NotConfiguredMilestoneProvider implements MilestoneProvider {
  readonly id = 'none';
  readonly name = NOT_CONFIGURED;

  async subscribe(_req: SubscribeRequest): Promise<SubscribeResult> {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message:
        'No milestone provider is configured (TRACKING_MILESTONE_PROVIDER=none). Events can be added manually.',
    };
  }

  async unsubscribe(_providerRef: string): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  parseWebhook(): WebhookParseResult {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message: 'No milestone provider is configured.',
    };
  }

  async pollShipment(_providerRef: string): Promise<PollResult> {
    return { ok: false, reason: 'NOT_CONFIGURED', message: 'No milestone provider is configured.' };
  }
}

export class NotConfiguredPositionProvider implements PositionProvider {
  readonly name = NOT_CONFIGURED;
  readonly configured = false;
  readonly maxImosPerCall = 1;

  async positions(_imos: readonly string[]): Promise<VesselPosition[]> {
    throw new Error('No vessel-position provider is configured (TRACKING_POSITION_PROVIDER=none).');
  }
}
