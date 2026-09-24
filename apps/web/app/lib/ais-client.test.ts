import { describe, expect, it } from 'vitest';
import {
  AIS_MAX_VESSELS,
  AIS_STALE_MS,
  aisSubscribeMessage,
  decodeAisVessels,
  encodeAisVessels,
  parseAisError,
  parseAisMessage,
  upsertAisVessel,
  type AisVessel,
} from './ais-client';

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    MessageType: 'PositionReport',
    Message: {
      PositionReport: {
        UserID: 232012345,
        Latitude: 50.4,
        Longitude: -1.2,
        Sog: 14.5,
        Cog: 78.2,
        ...over,
      },
    },
  });

describe('ais-client', () => {
  it('builds the aisstream subscription for the UK box', () => {
    const msg = JSON.parse(aisSubscribeMessage('k')) as Record<string, unknown>;
    expect(msg).toEqual({
      APIKey: 'k',
      BoundingBoxes: [
        [
          [48, -12],
          [61, 9],
        ],
      ],
      FilterMessageTypes: ['PositionReport'],
    });
  });

  it('parses a position report and ignores everything else', () => {
    expect(parseAisMessage(report(), 1000)).toEqual({
      mmsi: '232012345',
      lat: 50.4,
      lon: -1.2,
      speedKnots: 14.5,
      courseDeg: 78.2,
      seenAt: 1000,
    });
    expect(parseAisMessage('{"MessageType":"ShipStaticData"}', 1)).toBeNull();
    expect(parseAisMessage('not json', 1)).toBeNull();
    expect(parseAisMessage(report({ Latitude: 'x' }), 1)).toBeNull();
    expect(parseAisMessage(report({ Latitude: 91 }), 1)).toBeNull();
  });

  it('treats the AIS "not available" sentinels as unknown', () => {
    const v = parseAisMessage(report({ Sog: 102.3, Cog: 360 }), 1)!;
    expect(v.speedKnots).toBe(0);
    expect(v.courseDeg).toBe(0);
  });

  it('keeps the cache bounded and drops silent vessels', () => {
    const cache = new Map<string, AisVessel>();
    const v = (mmsi: string, seenAt: number): AisVessel => ({
      mmsi,
      lat: 50,
      lon: 0,
      speedKnots: 0,
      courseDeg: 0,
      seenAt,
    });
    for (let i = 0; i < AIS_MAX_VESSELS + 10; i += 1)
      upsertAisVessel(cache, v(String(i), 1000), 1000);
    expect(cache.size).toBe(AIS_MAX_VESSELS);
    expect(cache.has('0')).toBe(false);
    expect(cache.has(String(AIS_MAX_VESSELS + 9))).toBe(true);

    const later = 1000 + AIS_STALE_MS + 1;
    upsertAisVessel(cache, v('fresh', later), later);
    expect(cache.size).toBe(1);
    expect(cache.has('fresh')).toBe(true);
  });

  it('recognises the provider refusing a key, and nothing else, as an error', () => {
    expect(parseAisError('{"error":"Api Key Is Not Valid"}')).toBe('Api Key Is Not Valid');
    expect(parseAisError(report())).toBeNull();
    expect(parseAisError('{"error":""}')).toBeNull();
    expect(parseAisError('nope')).toBeNull();
  });

  it('round-trips vessels through the compact wire format, rounding for size', () => {
    const v: AisVessel = {
      mmsi: '232012345',
      lat: 50.123456789,
      lon: -1.23456789,
      speedKnots: 14.57,
      courseDeg: 78.6,
      seenAt: 1000,
    };
    const wire = encodeAisVessels([v]);
    expect(wire).toEqual([['232012345', 50.12346, -1.23457, 14.6, 79, 1000]]);
    expect(decodeAisVessels(JSON.parse(JSON.stringify(wire)))).toEqual([
      {
        mmsi: '232012345',
        lat: 50.12346,
        lon: -1.23457,
        speedKnots: 14.6,
        courseDeg: 79,
        seenAt: 1000,
      },
    ]);
    expect(decodeAisVessels([['x', 1, 2, 3], 'junk', [1, 2, 3, 4, 5, 6], null])).toEqual([]);
    expect(decodeAisVessels('not a list')).toEqual([]);
  });
});
