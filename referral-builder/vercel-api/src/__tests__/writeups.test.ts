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

// ============================================================================
// Multi-agreement dropdown variants + slash-combined names (2026-07 goal:
// "programs listed in HubSpot don't always get matched to the write ups")
// ============================================================================

import { cleanCampName, matchCandidates } from '../lib/writeups';

describe('cleanCampName', () => {
  test('strips agreement parentheticals', () => {
    expect(cleanCampName('MED-O-LARK (January 2024 forward)')).toBe('MED-O-LARK');
    expect(cleanCampName('KIPPEWA POINT (FIRST YEAR)')).toBe('KIPPEWA POINT');
    expect(cleanCampName('WESTCOAST CONNECTION (OUTSIDE OF USA)')).toBe(
      'WESTCOAST CONNECTION'
    );
  });

  test('strips zz inactive markers', () => {
    expect(cleanCampName('zz(NOT USING SERVICES) MOHAWK DAY NYC- NJ')).toBe(
      'MOHAWK DAY NYC- NJ'
    );
  });

  test('strips trailing agreement counters but keeps leading digits', () => {
    expect(cleanCampName('ARROW WOOD 3')).toBe('ARROW WOOD');
    expect(cleanCampName('6 POINTS SPORTS')).toBe('6 POINTS SPORTS');
  });
});

describe('matchWriteup — agreement variants resolve to the base camp', () => {
  const records = [
    rec('Med-O-Lark'),
    rec('Kippewa Point'),
    rec('Arrowwood'),
    rec('Westcoast Connection'),
  ];

  test.each([
    ['MED-O-LARK (January 2024 forward)', 'Med-O-Lark'],
    ['KIPPEWA POINT (FIRST YEAR)', 'Kippewa Point'],
    ['WESTCOAST CONNECTION (OUTSIDE OF USA)', 'Westcoast Connection'],
  ])('%s → %s', (companyName, expected) => {
    const hit = matchWriteup(companyName, records);
    expect(hit?.rec.campName).toBe(expected);
  });

  test('spacing variants converge ("ARROW WOOD 3" → "Arrowwood")', () => {
    const hit = matchWriteup('ARROW WOOD 3', records);
    expect(hit?.rec.campName).toBe('Arrowwood');
    expect(hit!.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe('matchWriteup — slash names use the camp before the slash', () => {
  test('picks the first segment even when later segments also have write-ups', () => {
    const records = [rec('Pine Forest'), rec('Timber Tops'), rec('Lake Owego')];
    const hit = matchWriteup('LAKE OWEGO/PINE FOREST/TIMBER TOPS', records);
    expect(hit?.rec.campName).toBe('Lake Owego');
  });

  test('falls back to later segments when the first has no write-up', () => {
    const records = [rec('Chestnut Lake')];
    const hit = matchWriteup('TRAILS END /CHESTNUT LAKE', records);
    expect(hit?.rec.campName).toBe('Chestnut Lake');
  });

  test('candidate order: first segment, cleaned full, raw, rest', () => {
    const cands = matchCandidates('LAKE OWEGO/PINE FOREST (2024) ');
    expect(cands[0]).toBe('LAKE OWEGO');
  });
});
