/**
 * Unit tests for the property-name migration helpers.
 */

import {
  pickReferralProperty,
  dualWriteReferralProperty,
  findUnmigratedReferralWrites,
  REFERRAL_PROPERTY_PAIRS,
  REFERRAL_DUAL_READ_PROPERTIES,
} from '../lib/property-aliases';

describe('pickReferralProperty', () => {
  test('prefers canonical when both are set', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: 'Selected',
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Active',
    };
    expect(pickReferralProperty(props, 'interest')).toBe('Selected');
  });

  test('falls back to legacy when canonical is empty', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: '',
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Selected',
    };
    expect(pickReferralProperty(props, 'interest')).toBe('Selected');
  });

  test('falls back to legacy when canonical is null', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: null,
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Selected',
    };
    expect(pickReferralProperty(props, 'interest')).toBe('Selected');
  });

  test('returns null when both are empty', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: '',
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: '',
    };
    expect(pickReferralProperty(props, 'interest')).toBeNull();
  });

  test('returns null when neither key is present', () => {
    expect(pickReferralProperty({}, 'interest')).toBeNull();
  });

  test('works for outreach pair too', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.outreach.canonical]: 'Sent',
    };
    expect(pickReferralProperty(props, 'outreach')).toBe('Sent');
  });
});

describe('dualWriteReferralProperty', () => {
  test('returns BOTH canonical + legacy entries with the same value', () => {
    const result = dualWriteReferralProperty('interest', 'Selected');
    expect(result).toEqual({
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: 'Selected',
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Selected',
    });
  });

  test('returns empty object when value is undefined', () => {
    expect(dualWriteReferralProperty('interest', undefined)).toEqual({});
  });

  test('writes empty string explicitly when value is empty', () => {
    const result = dualWriteReferralProperty('interest', '');
    expect(result).toEqual({
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: '',
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: '',
    });
  });

  test('spreads cleanly into a payload object', () => {
    const payload = {
      referral_key: 'k1',
      ...dualWriteReferralProperty('interest', 'Shortlist'),
      ...dualWriteReferralProperty('outreach', 'Sent'),
    };
    expect(payload[REFERRAL_PROPERTY_PAIRS.interest.canonical]).toBe('Shortlist');
    expect(payload[REFERRAL_PROPERTY_PAIRS.interest.legacy]).toBe('Shortlist');
    expect(payload[REFERRAL_PROPERTY_PAIRS.outreach.canonical]).toBe('Sent');
    expect(payload[REFERRAL_PROPERTY_PAIRS.outreach.legacy]).toBe('Sent');
    expect(payload.referral_key).toBe('k1');
  });
});

describe('findUnmigratedReferralWrites', () => {
  test('flags writes that hit only the legacy name', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Selected',
    };
    expect(findUnmigratedReferralWrites(props)).toEqual(['interest']);
  });

  test('does not flag dual-writes', () => {
    const props = {
      ...dualWriteReferralProperty('interest', 'Selected'),
    };
    expect(findUnmigratedReferralWrites(props)).toEqual([]);
  });

  test('does not flag canonical-only writes', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.canonical]: 'Selected',
    };
    expect(findUnmigratedReferralWrites(props)).toEqual([]);
  });

  test('flags multiple unmigrated writes in one payload', () => {
    const props = {
      [REFERRAL_PROPERTY_PAIRS.interest.legacy]: 'Selected',
      [REFERRAL_PROPERTY_PAIRS.outreach.legacy]: 'Sent',
    };
    expect(findUnmigratedReferralWrites(props).sort()).toEqual(['interest', 'outreach']);
  });
});

describe('REFERRAL_DUAL_READ_PROPERTIES', () => {
  test('includes both names for both pairs', () => {
    expect(REFERRAL_DUAL_READ_PROPERTIES).toEqual(
      expect.arrayContaining([
        REFERRAL_PROPERTY_PAIRS.outreach.canonical,
        REFERRAL_PROPERTY_PAIRS.outreach.legacy,
        REFERRAL_PROPERTY_PAIRS.interest.canonical,
        REFERRAL_PROPERTY_PAIRS.interest.legacy,
      ])
    );
  });

  test('canonical names are the actual HubSpot internal names', () => {
    expect(REFERRAL_PROPERTY_PAIRS.outreach.canonical).toBe('referral_status');
    expect(REFERRAL_PROPERTY_PAIRS.interest.canonical).toBe('client_interest');
  });
});
