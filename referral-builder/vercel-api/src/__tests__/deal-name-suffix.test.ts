/**
 * Unit tests for the deal-name ⇄ attending-program suffix helpers (item 2).
 * Pure functions — no HubSpot/DB mocking needed.
 */

import {
  reconcileDealName,
  stripProgramFromDealName,
} from '../lib/deals';

describe('stripProgramFromDealName', () => {
  test('removes the exact " — {program}" suffix', () => {
    expect(stripProgramFromDealName('Jane Doe 2026 — Camp Adventure', 'Camp Adventure')).toBe(
      'Jane Doe 2026'
    );
  });

  test('leaves the name unchanged when the suffix is absent', () => {
    expect(stripProgramFromDealName('Jane Doe 2026', 'Camp Adventure')).toBe('Jane Doe 2026');
  });

  test('no-ops when program is empty', () => {
    expect(stripProgramFromDealName('Jane Doe 2026 — Camp Adventure', '')).toBe(
      'Jane Doe 2026 — Camp Adventure'
    );
  });
});

describe('reconcileDealName', () => {
  test('appends the program when the deal should carry it', () => {
    expect(
      reconcileDealName({
        currentName: 'Jane Doe 2026',
        programName: 'Camp Adventure',
        shouldHaveProgram: true,
      })
    ).toBe('Jane Doe 2026 — Camp Adventure');
  });

  test('is idempotent — never double-appends', () => {
    const once = reconcileDealName({
      currentName: 'Jane Doe 2026',
      programName: 'Camp Adventure',
      shouldHaveProgram: true,
    });
    const twice = reconcileDealName({
      currentName: once,
      programName: 'Camp Adventure',
      shouldHaveProgram: true,
    });
    expect(twice).toBe('Jane Doe 2026 — Camp Adventure');
  });

  test('strips the program when the deal should not carry it (reverse)', () => {
    expect(
      reconcileDealName({
        currentName: 'Jane Doe 2026 — Camp Adventure',
        programName: 'Camp Adventure',
        shouldHaveProgram: false,
      })
    ).toBe('Jane Doe 2026');
  });

  test('swaps the suffix when the program changes', () => {
    expect(
      reconcileDealName({
        currentName: 'Jane Doe 2026 — Old Camp',
        programName: 'Old Camp',
        shouldHaveProgram: true,
      })
    ).toBe('Jane Doe 2026 — Old Camp');
    // After a program change the caller passes the new programName; the old
    // suffix is only stripped when it matches the program passed in, so the
    // reverse-then-append cycle (via two reconciles) lands cleanly.
    const cleaned = reconcileDealName({
      currentName: 'Jane Doe 2026 — Old Camp',
      programName: 'Old Camp',
      shouldHaveProgram: false,
    });
    expect(
      reconcileDealName({
        currentName: cleaned,
        programName: 'New Camp',
        shouldHaveProgram: true,
      })
    ).toBe('Jane Doe 2026 — New Camp');
  });
});
