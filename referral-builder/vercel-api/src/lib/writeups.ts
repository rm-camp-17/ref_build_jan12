/**
 * Camp write-up provider.
 *
 * The memo builder needs the qualitative narrative ("write-up") for each camp
 * the rep selects. Those write-ups live in a Google Drive folder owned by the
 * Camp Experts team and are NOT reachable from the Vercel runtime. We mirror
 * them into a committed data file (`data/writeups.json`, extracted from Drive)
 * so the backend can read them with zero runtime setup — no Google credentials,
 * no CRM writes, no live Drive dependency.
 *
 * Matching is by camp name: the card sends the deal's associated company names,
 * and we fuzzy-match each to a write-up. Drive titles are inconsistent
 * (`Chestnut_Lake_Camp_Write_Up`, `Camp KenMont & KenWood Write-Up`, plus many
 * `… Recap` call-notes), so we normalize both sides to a slug and score the
 * overlap. A true "writeup" beats a "recap" of equal match quality.
 *
 * Source is selectable via config.memo.writeupSource:
 *   - 'seed' (default): the committed data/writeups.json
 *   - 'db'            : a `camp_writeups` table in the session Postgres
 *   - 'auto'          : try db, fall back to seed
 */

import rawWriteups from '../../data/writeups.json';
import { config } from './config';
import { query } from './pg';

export interface WriteupRecord {
  driveFileId: string;
  title: string;
  campName: string;
  slug: string;
  docType: 'writeup' | 'recap';
  text: string;
}

export interface ResolvedWriteup {
  campName: string;
  docType: 'writeup' | 'recap';
  text: string;
  source: 'seed' | 'db';
  driveFileId: string | null;
  /** 0–100 match confidence (100 = exact slug match). */
  matchScore: number;
}

// ============================================================================
// Name normalization
// ============================================================================

// Noise tokens that don't help disambiguate a camp: doc-type words, generic
// "camp" filler, and corporate suffixes. State abbreviations are intentionally
// NOT stripped here (handled by callers when needed) so "Green Cove NC" can be
// told apart from another "Green Cove".
const NOISE_TOKENS = new Set([
  'camp',
  'camps',
  'the',
  'and',
  'write',
  'up',
  'writeup',
  'zoom',
  'recap',
  'summary',
  'notes',
  'program',
  'inc',
  'llc',
  'ltd',
  'co',
  'international',
  'zz', // inactive-partner marker prefix ("zz(NOT USING SERVICES) …")
]);

/**
 * Normalize a company / camp name to a comparable slug: lowercase, expand `&`,
 * strip punctuation, drop noise tokens, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NOISE_TOKENS.has(t))
    .join(' ')
    .trim();
}

/**
 * Strip the agreement/bookkeeping decorations HubSpot dropdown variants carry
 * so multiple agreements for one camp all resolve to the same base name:
 *
 *   "MED-O-LARK (January 2024 forward)"  → "MED-O-LARK"
 *   "KIPPEWA POINT (FIRST YEAR)"         → "KIPPEWA POINT"
 *   "ARROW WOOD 3"                       → "ARROW WOOD"   (trailing digit only —
 *                                          leading digits like "6 POINTS" stay)
 *   "zz(NOT USING SERVICES) MOHAWK DAY"  → "MOHAWK DAY"
 */
export function cleanCampName(name: string): string {
  let s = (name || '')
    .replace(/^\s*zz\s*/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Trailing standalone agreement counters ("ARROW WOOD 3") — but never strip
  // a name down to nothing or touch leading digits ("6 POINTS SPORTS").
  const stripped = s.replace(/(\s+\d{1,4})+$/g, '').trim();
  if (stripped) s = stripped;
  return s;
}

/**
 * Ordered candidate names to try when matching a company to a write-up:
 *   1. The first "/" segment (cleaned) — when a dropdown lists several camps,
 *      the camp before the slash is the one that applies; the rest are
 *      extraneous ("Lake Owego/Pine Forest/Timber Tops" → Lake Owego).
 *   2. The cleaned full name (agreement qualifiers stripped).
 *   3. The raw full name (keeps parenthetical aliases like "IHC (Indian Head)"
 *      available when the cleaned form is too thin).
 *   4. Remaining "/" segments, in order.
 */
export function matchCandidates(name: string): string[] {
  const raw = (name || '').trim();
  const cleaned = cleanCampName(raw);
  const segments = cleaned.includes('/')
    ? cleaned.split('/').map((s) => cleanCampName(s)).filter(Boolean)
    : [];
  const ordered = [
    ...(segments.length > 1 ? [segments[0]] : []),
    cleaned,
    raw,
    ...(segments.length > 1 ? segments.slice(1) : []),
  ];
  const seen = new Set<string>();
  return ordered.filter((c) => {
    const slug = normalizeName(c);
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
}

// Seed write-ups, with slugs recomputed via the SAME normalizer the
// company-name side uses, so matching never depends on however the extractor
// slugged each title. (Declared after normalizeName/NOISE_TOKENS to avoid a
// temporal-dead-zone reference at module load.)
const SEED: WriteupRecord[] = (rawWriteups as WriteupRecord[]).map((r) => ({
  ...r,
  slug: normalizeName(r.campName || r.title),
}));

// ============================================================================
// Matching
// ============================================================================

function tokenSet(slug: string): Set<string> {
  return new Set(slug.split(' ').filter(Boolean));
}

/**
 * Score how well a company slug matches a write-up record (0–100).
 * Exact match = 100; otherwise a blend of token-overlap (Jaccard) and a
 * containment bonus, with a small nudge for true write-ups over recaps.
 */
export function scoreMatch(companySlug: string, rec: WriteupRecord): number {
  const a = companySlug;
  const b = rec.slug;
  if (!a || !b) return 0;
  if (a === b) return 100 + (rec.docType === 'writeup' ? 1 : 0);

  // Spacing-insensitive forms so "Arrow Wood" ↔ "Arrowwood" converge.
  const aj = a.replace(/ /g, '');
  const bj = b.replace(/ /g, '');
  if (aj === bj) return 100 + (rec.docType === 'writeup' ? 1 : 0);

  const at = tokenSet(a);
  const bt = tokenSet(b);
  if (at.size === 0 || bt.size === 0) return 0;

  let overlap = 0;
  at.forEach((t) => {
    if (bt.has(t)) overlap++;
  });

  const joinedContainment =
    aj.length >= 4 && bj.length >= 4 && (aj.includes(bj) || bj.includes(aj));
  if (overlap === 0 && !joinedContainment) return 0;

  const jaccard = overlap / (at.size + bt.size - overlap);
  const aInB = [...at].every((t) => bt.has(t));
  const bInA = [...bt].every((t) => at.has(t));

  let s = jaccard * 60;
  if (aInB || bInA || joinedContainment) s += 30; // one name contains the other
  if (rec.docType === 'writeup') s += 5; // prefer curated write-ups over recaps
  return Math.min(s, 99);
}

// Minimum score to accept a match. Below this we treat the camp as having no
// write-up on file (→ "thin entry + flag" in the memo).
export const MATCH_THRESHOLD = 45;

/**
 * Pure matcher: pick the best-scoring record for a company name from a given
 * set. Tries the ordered matchCandidates() forms — first slash segment, then
 * the agreement-qualifier-stripped name, then the raw name, then remaining
 * segments — and returns the first candidate that clears the threshold, so a
 * multi-camp dropdown resolves to the camp before the "/" and an agreement
 * variant resolves to its base camp. Exported for unit tests against
 * synthetic records. Returns null when nothing clears the threshold.
 */
export function matchWriteup(
  name: string,
  records: WriteupRecord[]
): { rec: WriteupRecord; score: number } | null {
  for (const candidate of matchCandidates(name)) {
    const slug = normalizeName(candidate);
    let best: WriteupRecord | null = null;
    let bestScore = 0;
    for (const rec of records) {
      const score = scoreMatch(slug, rec);
      if (score > bestScore) {
        bestScore = score;
        best = rec;
      }
    }
    if (best && bestScore >= MATCH_THRESHOLD) {
      return { rec: best, score: bestScore };
    }
  }
  return null;
}

function bestSeedMatch(name: string): ResolvedWriteup | null {
  const hit = matchWriteup(name, SEED);
  if (!hit) return null;
  return {
    campName: hit.rec.campName,
    docType: hit.rec.docType,
    text: hit.rec.text,
    source: 'seed',
    driveFileId: hit.rec.driveFileId,
    matchScore: Math.round(hit.score),
  };
}

async function bestDbMatch(name: string): Promise<ResolvedWriteup | null> {
  if (!normalizeName(name)) return null;
  try {
    // The session Postgres may or may not have the camp_writeups table; if it
    // doesn't exist the query throws and we fall back to the seed.
    const rows = await query<{
      camp_name: string | null;
      slug: string | null;
      doc_type: string | null;
      writeup_text: string | null;
      drive_file_id: string | null;
    }>(
      `SELECT camp_name, slug, doc_type, writeup_text, drive_file_id
         FROM camp_writeups
        WHERE writeup_text IS NOT NULL AND writeup_text <> ''`,
      []
    );
    const records: WriteupRecord[] = rows.map((row) => ({
      driveFileId: row.drive_file_id ?? '',
      title: row.camp_name ?? '',
      campName: row.camp_name ?? '',
      slug: normalizeName(row.camp_name ?? ''),
      docType: row.doc_type === 'recap' ? 'recap' : 'writeup',
      text: row.writeup_text ?? '',
    }));
    const hit = matchWriteup(name, records);
    if (!hit) return null;
    return {
      campName: hit.rec.campName || name,
      docType: hit.rec.docType,
      text: hit.rec.text,
      source: 'db',
      driveFileId: hit.rec.driveFileId || null,
      matchScore: Math.round(hit.score),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the best write-up for a camp/company name, honoring the configured
 * source. Returns null when no write-up clears the match threshold — callers
 * render a "limited info" entry in that case.
 */
export async function getWriteupForCompany(
  name: string
): Promise<ResolvedWriteup | null> {
  const source = config.memo.writeupSource;
  if (source === 'db' || source === 'auto') {
    const dbHit = await bestDbMatch(name);
    if (dbHit) return dbHit;
    if (source === 'db') return null;
  }
  return bestSeedMatch(name);
}

/** Diagnostics: how many write-ups the seed holds, and the type split. */
export function getSeedStats(): {
  total: number;
  writeups: number;
  recaps: number;
} {
  return {
    total: SEED.length,
    writeups: SEED.filter((r) => r.docType === 'writeup').length,
    recaps: SEED.filter((r) => r.docType === 'recap').length,
  };
}
