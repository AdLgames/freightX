import { describe, expect, it } from 'vitest';
import {
  PLANS,
  PLAN_LIMITS,
  minimumPlanFor,
  planAllows,
  planAtLeast,
  planNoticeText,
} from './plan';

describe('PLAN_LIMITS (provisional, decision (z))', () => {
  it('FREE: calculator + 3 saved quotes + 10 products, no documents', () => {
    expect(PLAN_LIMITS.FREE).toEqual({
      calculator: true,
      savedQuotes: 3,
      products: 10,
      documents: false,
      members: 3,
    });
  });

  it('STARTER: unlimited quotes and products, documents; PRO: everything incl. members > 3', () => {
    expect(PLAN_LIMITS.STARTER).toMatchObject({
      savedQuotes: null,
      products: null,
      documents: true,
      members: 3,
    });
    expect(PLAN_LIMITS.PRO).toEqual({
      calculator: true,
      savedQuotes: null,
      products: null,
      documents: true,
      members: null,
    });
  });

  it('every plan has every feature and higher plans never allow less', () => {
    const features = Object.keys(PLAN_LIMITS.FREE) as Array<keyof typeof PLAN_LIMITS.FREE>;
    for (const f of features) {
      for (let i = 1; i < PLANS.length; i += 1) {
        for (const count of [0, 2, 3, 9, 10, 100]) {
          const lower = planAllows(PLANS[i - 1]!, f, count);
          const higher = planAllows(PLANS[i]!, f, count);
          expect(higher || !lower, `${PLANS[i]} ${f} @${count}`).toBe(true);
        }
      }
    }
  });
});

describe('planAllows / minimumPlanFor / planAtLeast', () => {
  it('counted features allow while count < limit', () => {
    expect(planAllows('FREE', 'savedQuotes', 2)).toBe(true);
    expect(planAllows('FREE', 'savedQuotes', 3)).toBe(false);
    expect(planAllows('STARTER', 'savedQuotes', 3000)).toBe(true);
    expect(planAllows('FREE', 'products', 9)).toBe(true);
    expect(planAllows('FREE', 'products', 10)).toBe(false);
    expect(planAllows('STARTER', 'members', 3)).toBe(false);
    expect(planAllows('PRO', 'members', 3)).toBe(true);
  });

  it('boolean features', () => {
    expect(planAllows('FREE', 'documents')).toBe(false);
    expect(planAllows('STARTER', 'documents')).toBe(true);
    expect(planAllows('FREE', 'calculator')).toBe(true);
  });

  it('fails closed on an unknown plan', () => {
    expect(planAllows('GOLD' as never, 'calculator')).toBe(false);
    expect(planAtLeast('GOLD' as never, 'FREE')).toBe(false);
  });

  it('names the cheapest plan that lifts the limit', () => {
    expect(minimumPlanFor('savedQuotes', 3)).toBe('STARTER');
    expect(minimumPlanFor('documents')).toBe('STARTER');
    expect(minimumPlanFor('members', 3)).toBe('PRO');
    expect(minimumPlanFor('calculator')).toBe('FREE');
  });

  it('orders FREE < STARTER < PRO', () => {
    expect(planAtLeast('PRO', 'STARTER')).toBe(true);
    expect(planAtLeast('STARTER', 'STARTER')).toBe(true);
    expect(planAtLeast('FREE', 'STARTER')).toBe(false);
  });
});

describe('planNoticeText', () => {
  it('reads the numbers from the table', () => {
    expect(planNoticeText('savedQuotes', 'STARTER')).toBe(
      'Upgrade to Starter to save more than 3 quotes.',
    );
    expect(planNoticeText('products', 'STARTER')).toBe(
      'Upgrade to Starter to keep more than 10 products.',
    );
    expect(planNoticeText('members', 'PRO')).toBe('Upgrade to Pro to add more than 3 members.');
    expect(planNoticeText('documents', 'STARTER')).toBe('Upgrade to Starter to store documents.');
  });
});
