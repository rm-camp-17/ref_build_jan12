/**
 * Unit tests for the row → PostgresSession formatter.
 *
 * Focused on the formatting logic (no DB connection required). Integration
 * tests against a real Postgres instance live in Phase 3b's session route.
 */

import { formatSession } from '../lib/sessions';

describe('formatSession', () => {
  test('formats a complete row from a Date object', () => {
    const result = formatSession({
      id: 42,
      name: 'Session 2A',
      start_date: new Date('2026-07-14T00:00:00Z'),
      end_date: new Date('2026-08-04T00:00:00Z'),
      tuition: '5000',
      tuition_currency: 'USD',
      weeks: '3',
      age_min: 10,
      age_max: 14,
      notes: 'Coed session',
      program_name: 'Summer Adventure',
      company_name: 'Camp Sunshine',
    });

    expect(result).toEqual({
      id: 42,
      name: 'Session 2A',
      startDate: 'Jul 14',
      endDate: 'Aug 4',
      startDateRaw: '2026-07-14',
      endDateRaw: '2026-08-04',
      tuition: 5000,
      currency: 'USD',
      weeks: 3,
      ageMin: 10,
      ageMax: 14,
      notes: 'Coed session',
      programName: 'Summer Adventure',
      companyName: 'Camp Sunshine',
    });
  });

  test('formats a row with date strings instead of Date objects', () => {
    const result = formatSession({
      id: 7,
      name: 'CIT',
      start_date: '2026-06-01',
      end_date: '2026-08-15',
      tuition: 8500,
      tuition_currency: 'CAD',
      weeks: 10.5,
      age_min: null,
      age_max: null,
      notes: null,
      program_name: null,
      company_name: 'Some Camp',
    });

    expect(result.startDate).toBe('Jun 1');
    expect(result.endDate).toBe('Aug 15');
    expect(result.startDateRaw).toBe('2026-06-01');
    expect(result.endDateRaw).toBe('2026-08-15');
    expect(result.tuition).toBe(8500);
    expect(result.currency).toBe('CAD');
    expect(result.weeks).toBe(10.5);
    expect(result.ageMin).toBeNull();
    expect(result.ageMax).toBeNull();
    expect(result.notes).toBe('');
    expect(result.programName).toBe('');
    expect(result.companyName).toBe('Some Camp');
  });

  test('falls back to defaults for nullable numeric fields', () => {
    const result = formatSession({
      id: 99,
      name: '',
      start_date: '2026-07-01',
      end_date: '2026-07-08',
      tuition: null,
      tuition_currency: null,
      weeks: null,
      age_min: null,
      age_max: null,
      notes: null,
      program_name: null,
      company_name: null,
    });

    expect(result.tuition).toBe(0);
    expect(result.currency).toBe('USD');
    expect(result.weeks).toBe(0);
  });
});
