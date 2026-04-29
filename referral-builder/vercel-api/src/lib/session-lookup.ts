/**
 * Session-lookup orchestration.
 *
 * Wraps the Postgres queries in lib/sessions.ts with the legacy
 * "try program_id, fall back to programname" logic the session card
 * uses. Returns a uniform shape regardless of which path matched.
 */

import {
  getSessionsForProgram,
  getSessionsByProgramName,
  PostgresSession,
} from './sessions';

export interface SessionLookupResult {
  sessions: PostgresSession[];
  programName: string;
  /** Non-null when the lookup failed in a user-visible way. */
  error: string | null;
}

export interface DealLookupContext {
  program_id: string | null;
  programname: string | null;
  year1: string | null;
}

/**
 * Look up sessions for a deal. Tries `program_id` first (the canonical
 * legacy ID = `companies.access_id` in Postgres), falls back to
 * `programname` if that comes up empty.
 */
export async function lookupSessions(
  deal: DealLookupContext
): Promise<SessionLookupResult> {
  const { program_id, programname, year1 } = deal;
  const year = year1 ? parseInt(year1, 10) : NaN;

  if (!Number.isFinite(year)) {
    return {
      sessions: [],
      programName: programname || '',
      error: 'Deal is missing a valid year.',
    };
  }

  if (!program_id && !programname) {
    return {
      sessions: [],
      programName: '',
      error:
        'No program selected on this deal. Mark a referral as Selected first.',
    };
  }

  // Path 1: program_id → companies.access_id
  if (program_id) {
    try {
      const sessions = await getSessionsForProgram(program_id, year);
      if (sessions.length > 0) {
        return {
          sessions,
          programName: programname || sessions[0].companyName,
          error: null,
        };
      }
    } catch (err: any) {
      console.warn(
        '[session-lookup] program_id path failed, trying name match',
        { program_id, error: err.message }
      );
    }
  }

  // Path 2: fall back to programname
  if (programname) {
    try {
      const sessions = await getSessionsByProgramName(programname, year);
      if (sessions.length > 0) {
        return { sessions, programName: programname, error: null };
      }
    } catch (err: any) {
      console.warn(
        '[session-lookup] programname path failed',
        { programname, error: err.message }
      );
    }
  }

  return {
    sessions: [],
    programName: programname || '',
    error: `No sessions found for ${
      programname || `program ${program_id}`
    } in ${year}. Use manual entry below.`,
  };
}
