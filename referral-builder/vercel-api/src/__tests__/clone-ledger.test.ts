/**
 * Tests the clone_ledger self-heal: ensureCloneLedgerTable creates the table
 * (CREATE TABLE / INDEX IF NOT EXISTS) once per process, so environments where
 * migration 001 was never applied stop throwing
 * `relation "clone_ledger" does not exist` on every clone.
 */

const mockQuery = jest.fn().mockResolvedValue([]);
jest.mock('../lib/pg', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { ensureCloneLedgerTable } from '../lib/clone-ledger';

describe('ensureCloneLedgerTable', () => {
  test('creates the table + index once, then no-ops (guarded per process)', async () => {
    await ensureCloneLedgerTable();

    const sql = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /CREATE TABLE IF NOT EXISTS clone_ledger/i.test(s))).toBe(
      true
    );
    expect(
      sql.some((s) => /CREATE INDEX IF NOT EXISTS clone_ledger_target_year_idx/i.test(s))
    ).toBe(true);

    const callsAfterFirst = mockQuery.mock.calls.length;
    await ensureCloneLedgerTable();
    // Guarded: a second call issues no further queries.
    expect(mockQuery.mock.calls.length).toBe(callsAfterFirst);
  });
});
