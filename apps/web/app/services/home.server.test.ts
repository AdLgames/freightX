import { describe, expect, it } from 'vitest';
import { homeAlerts, type ArrivalInput } from './home.server';

const NOW = new Date('2026-09-24T12:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
  shipmentId: '11111111-1111-4111-8111-111111111111',
  reference: 'Autumn stock',
  destinationName: 'Felixstowe',
  etaIso: inDays(3),
  quoteId: null,
  documentTypes: ['COMMERCIAL_INVOICE', 'PACKING_LIST'],
  ...over,
});
const profile = { eoriNumber: 'GB123', customsProfile: null };

describe('homeAlerts', () => {
  it('raises a critical alert for an arrival within a week that has no release document', () => {
    const alerts = homeAlerts({ ...profile, arrivals: [arrival()] }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: 'critical',
      title: 'Release document missing',
      actionHref: '/app/documents/new?type=BILL_OF_LADING',
      secondary: { href: '/app/tracking/11111111-1111-4111-8111-111111111111' },
    });
    expect(alerts[0]?.message).toContain('Autumn stock arrives in 3 days at Felixstowe');
    expect(alerts[0]?.message).toContain('demurrage');
  });

  it('is satisfied by a bill of lading or an air waybill, and ignores far-off arrivals', () => {
    const ok = homeAlerts(
      {
        ...profile,
        arrivals: [
          arrival({ documentTypes: ['BILL_OF_LADING'] }),
          arrival({ shipmentId: '2', documentTypes: ['AIRWAY_BILL'] }),
          arrival({ shipmentId: '3', etaIso: inDays(20) }),
        ],
      },
      NOW,
    );
    expect(ok).toEqual([]);
  });

  it('phrases today, tomorrow and overdue arrivals, soonest first, and links the quote upload', () => {
    const alerts = homeAlerts(
      {
        ...profile,
        arrivals: [
          arrival({ shipmentId: 'b', reference: 'B', etaIso: inDays(1) }),
          arrival({ shipmentId: 'a', reference: 'A', etaIso: inDays(-2), destinationName: null }),
          arrival({ shipmentId: 'c', reference: null, etaIso: inDays(0), quoteId: 'q1' }),
        ],
      },
      NOW,
    );
    expect(alerts.map((a) => a.id)).toEqual([
      'release_missing:a',
      'release_missing:c',
      'release_missing:b',
    ]);
    expect(alerts[0]?.message).toContain('A arrived 2 days ago.');
    expect(alerts[1]?.message).toContain('A shipment arrives today at Felixstowe');
    expect(alerts[1]?.actionHref).toBe('/app/documents/new?quoteId=q1&type=BILL_OF_LADING');
    expect(alerts[2]?.message).toContain('B arrives tomorrow');
  });

  it('appends the customs-profile items as warnings after the critical ones', () => {
    const alerts = homeAlerts(
      {
        eoriNumber: null,
        customsProfile: { paymentMethod: 'OWN_DEFERMENT', cdsAuthorityGranted: false },
        arrivals: [arrival()],
      },
      NOW,
    );
    expect(alerts.map((a) => a.level)).toEqual(['critical', 'warning', 'warning']);
    expect(alerts[1]).toMatchObject({ id: 'eori_missing', actionHref: '/app/settings' });
    expect(alerts[2]?.id).toBe('cds_authority_missing');
  });
});
