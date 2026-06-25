/**
 * Unit tests for the write-up matcher (the load-bearing, name-fuzzy part of the
 * memo builder's write-up provider). Uses synthetic records so the tests don't
 * depend on the live data/writeups.json seed (which changes as Drive changes).
 */

import {
  normalizeName,
  scoreMatch,
  matchWriteup,
  MATCH_THRESHOLD,
  type WriteupRecord,
} from '../lib/writeups';

function rec(
  campName: string,
  docType: 'writeup' | 'recap' = 'writeup'
): WriteupRecord {
  return {
    driveFileId: `id-${campName}`,
    title: campName,
    campName,
    slug: normalizeName(campName),
    docType,
    text: `Narrative for ${campName}`,
  };
}

describe('normalizeName', () => {
  test('lowercases, strips punctuation, drops "camp"/"write up" noise', () => {
    expect(normalizeName('Chestnut_Lake_Camp_Write_Up')).toBe('chestnut lake');
    expect(normalizeName('Poyntelle Write-Up')).toBe('poyntelle');
  });

  test('expands & and drops the conjunction so KenMont variants converge', () => {
    expect(normalizeName('Camp KenMont & KenWood Write-Up')).toBe(
      'kenmont kenwood'
    );
    expect(normalizeName('KenMont KenWood')).toBe('kenmont kenwood');
  });

  test('blank / junk input yields empty string', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ---  ')).toBe('');
  });
});

describe('scoreMatch', () => {
  test('exact slug match scores ~100 (writeup gets the tie-break bump)', () => {
    expect(scoreMatch('chestnut lake', rec('Chestnut Lake Camp'))).toBeGreaterThanOrEqual(
      100
    );
  });

  test('disjoint names score 0', () => {
    expect(scoreMatch('island lake', rec('Birchmont'))).toBe(0);
  });

  test('containment (one name a subset of the other) clears the threshold', () => {
    // "green cove" company vs "green cove nc" record
    expect(scoreMatch('green cove', rec('Green Cove NC'))).toBeGreaterThanOrEqual(
      MATCH_THRESHOLD
    );
  });
});

describe('matchWriteup', () => {
  const records = [
    rec('Chestnut Lake Camp'),
    rec('Camp KenMont & KenWood'),
    rec('Poyntelle'),
    rec('Bryn Mawr', 'recap'),
  ];

  test('matches a company name to its write-up', () => {
    const hit = matchWriteup('Chestnut Lake', records);
    expect(hit?.rec.campName).toBe('Chestnut Lake Camp');
  });

  test('matches across &/"and"/Camp-prefix variation', () => {
    const hit = matchWriteup('KenMont and KenWood', records);
    expect(hit?.rec.campName).toBe('Camp KenMont & KenWood');
  });

  test('returns null when no record clears the threshold', () => {
    expect(matchWriteup('Timber Lake West', records)).toBeNull();
  });

  test('prefers a true write-up over a recap of equal text match', () => {
    const dup = [rec('Pine Forest', 'recap'), rec('Pine Forest', 'writeup')];
    const hit = matchWriteup('Pine Forest', dup);
    expect(hit?.rec.docType).toBe('writeup');
  });
});
