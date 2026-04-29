/**
 * Session lookup against the external Postgres DB.
 *
 * Schema (camp/program/session — sessions live in Postgres, NOT HubSpot):
 *
 *   companies (id, access_id, name, ...)        — companies.access_id is the
 *                                                  legacy ID set on the
 *                                                  HubSpot Company.programid
 *                                                  property; THAT is the join
 *                                                  key from the deal side.
 *   programs  (id, company_id, name, ...)
 *   sessions  (id, program_id, company_id,
 *              name, start_date, end_date,
 *              tuition, tuition_currency,
 *              weeks, age_min, age_max, notes)
 *
 * The card flow:
 *   deal.program_id  →  Company.programid  =  companies.access_id
 *                                              ↓
 *                                              programs/sessions JOIN
 */

import { query } from './pg';

// ============================================================================
// Types
// ============================================================================

/**
 * A session as returned by the lookup. Dates come in two forms:
 *   - `startDate` / `endDate`: human-readable ("Jul 14") for display in the card
 *   - `startDateRaw` / `endDateRaw`: ISO `YYYY-MM-DD` for writing back to deal
 */
export interface PostgresSession {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  startDateRaw: string;
  endDateRaw: string;
  tuition: number;
  currency: string;
  weeks: number;
  ageMin: number | null;
  ageMax: number | null;
  notes: string;
  programName: string;
  companyName: string;
}

interface SessionRow {
  id: number;
  name: string | null;
  start_date: Date | string;
  end_date: Date | string;
  tuition: string | number | null;
  tuition_currency: string | null;
  weeks: string | number | null;
  age_min: number | null;
  age_max: number | null;
  notes: string | null;
  program_name: string | null;
  company_name: string | null;
}

// ============================================================================
// Queries
// ============================================================================

const SESSION_SELECT = `
  SELECT
    s.id,
    s.name,
    s.start_date,
    s.end_date,
    s.tuition,
    s.tuition_currency,
    s.weeks,
    s.age_min,
    s.age_max,
    s.notes,
    p.name AS program_name,
    c.name AS company_name
  FROM sessions s
  JOIN programs p ON p.id = s.program_id
  JOIN companies c ON c.id = s.company_id
`;

/**
 * Sessions belonging to the program identified by `Company.programid`
 * (= `companies.access_id` in Postgres) for a given year. This is the
 * primary lookup the session-selection card uses.
 */
export async function getSessionsForProgram(
  companyAccessId: string | number,
  year: number
): Promise<PostgresSession[]> {
  const accessId = typeof companyAccessId === 'string'
    ? parseInt(companyAccessId, 10)
    : companyAccessId;

  if (!Number.isFinite(accessId)) {
    return [];
  }

  const rows = await query<SessionRow>(
    `${SESSION_SELECT}
     WHERE c.access_id = $1
       AND EXTRACT(YEAR FROM s.start_date) = $2
     ORDER BY s.start_date ASC`,
    [accessId, year]
  );

  return rows.map(formatSession);
}

/**
 * Fallback lookup by camp display name. Used when `Company.programid` is
 * missing on the deal but `programname` is set. Case-insensitive exact
 * match on `companies.name`.
 */
export async function getSessionsByProgramName(
  programName: string,
  year: number
): Promise<PostgresSession[]> {
  const rows = await query<SessionRow>(
    `${SESSION_SELECT}
     WHERE UPPER(c.name) = UPPER($1)
       AND EXTRACT(YEAR FROM s.start_date) = $2
     ORDER BY s.start_date ASC`,
    [programName, year]
  );

  return rows.map(formatSession);
}

/**
 * Single session by Postgres ID — used after the rep clicks Submit on a
 * specific session, to fetch the canonical row for writing tuition/dates
 * onto the deal.
 */
export async function getSessionById(
  sessionId: string | number
): Promise<PostgresSession | null> {
  const rows = await query<SessionRow>(
    `${SESSION_SELECT}
     WHERE s.id = $1`,
    [sessionId]
  );

  return rows.length > 0 ? formatSession(rows[0]) : null;
}

// ============================================================================
// Formatting
// ============================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toIsoString(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function formatHumanDate(value: Date | string): string {
  const iso = toIsoString(value).substring(0, 10);
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function formatRawDate(value: Date | string): string {
  return toIsoString(value).substring(0, 10);
}

export function formatSession(row: SessionRow): PostgresSession {
  return {
    id: row.id,
    name: row.name ?? '',
    startDate: formatHumanDate(row.start_date),
    endDate: formatHumanDate(row.end_date),
    startDateRaw: formatRawDate(row.start_date),
    endDateRaw: formatRawDate(row.end_date),
    tuition: row.tuition !== null ? Number(row.tuition) : 0,
    currency: row.tuition_currency ?? 'USD',
    weeks: row.weeks !== null ? Number(row.weeks) : 0,
    ageMin: row.age_min,
    ageMax: row.age_max,
    notes: row.notes ?? '',
    programName: row.program_name ?? '',
    companyName: row.company_name ?? '',
  };
}
