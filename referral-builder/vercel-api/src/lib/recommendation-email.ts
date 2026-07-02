/**
 * Quick recommendation email — the light-weight companion to the full memo.
 *
 * The memo (Claude-composed .docx) is the deep read; this is the short,
 * instantly-generated email the Camp Expert pastes into their mail client to
 * deliver the recommendations: a friendly intro, one bullet per camp with its
 * short program name, location, website link, and the camp's own
 * "Four-Sentence Summary for Parents" (a company property maintained exactly
 * for this), and a closer that references the attached memo.
 *
 * Deliberately deterministic — no AI call — so it returns in ~1s, never hits
 * a gateway timeout, and always says exactly what the source data says. The
 * expert personalizes the greeting placeholders when pasting.
 *
 * The composed email is also logged as a Note on the deal so there's a record
 * of what was recommended (and reps can copy it from the timeline too).
 */

import { hubspotClient } from './hubspot';
import { config } from './config';
import { formatLocation, titleCase } from './us-states';

// ============================================================================
// Types
// ============================================================================

export interface EmailCamp {
  companyId: string;
  /** Parent-facing display name (short_program_name, falling back to name). */
  displayName: string;
  /** "Beach Lake, PA" — from the company record; '' when not on file. */
  location: string;
  /** Absolute URL, or '' when the company has none on file. */
  website: string;
  /** The camp's four-sentence parent summary, or '' when not on file. */
  summary: string;
}

export interface ComposedEmail {
  subject: string;
  body: string;
  camps: EmailCamp[];
  /** Camps that had no four-sentence summary on file (shown to the rep). */
  campsMissingSummary: string[];
}

// ============================================================================
// Company lookup
// ============================================================================

/** Ensure a website string is a usable absolute URL (or '' if unusable). */
function normalizeUrl(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, '')}`;
}

export async function getEmailCamp(companyId: string): Promise<EmailCamp> {
  try {
    const c: any = await hubspotClient.crm.companies.basicApi.getById(companyId, [
      'name',
      'short_program_name',
      'website_for_recommendation_entry',
      'website',
      'domain',
      'city',
      'state',
      'four_sentence_summary_for_parents',
    ]);
    const p = c?.properties ?? {};
    const displayName =
      (p.short_program_name || '').trim() ||
      titleCase(p.name || '') ||
      `Camp ${companyId}`;
    const location = formatLocation(p.city ?? '', p.state ?? '');
    return {
      companyId,
      displayName,
      location,
      website: normalizeUrl(
        p.website_for_recommendation_entry || p.website || p.domain || ''
      ),
      summary: (p.four_sentence_summary_for_parents || '').trim(),
    };
  } catch {
    return {
      companyId,
      displayName: `Camp ${companyId}`,
      location: '',
      website: '',
      summary: '',
    };
  }
}

// ============================================================================
// Compose
// ============================================================================

export function composeRecommendationEmail(
  camps: EmailCamp[],
  ctx: { summerYear: string; expertName: string }
): ComposedEmail {
  const year = ctx.summerYear ? ` ${ctx.summerYear}` : '';
  const subject = `Camp recommendations for summer${year}`;

  const lines: string[] = [];
  lines.push('Hi [Parent name],');
  lines.push('');
  lines.push(
    `It was great speaking with you! Based on our conversation, here are the camps I'd love for you to take a look at for summer${year}:`
  );
  lines.push('');

  for (const camp of camps) {
    // One header line per camp; the full URL stays clickable when pasted into
    // a mail client (display-domain-only text usually isn't auto-linked).
    const header = [
      camp.displayName,
      camp.location ? `(${camp.location})` : '',
      camp.website ? `— ${camp.website}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`• ${header}`);
    if (camp.summary) lines.push(`  ${camp.summary}`);
    lines.push('');
  }

  lines.push(
    "I've also attached a memo with a deeper look at each camp — the feel of each place, what it's known for, and the key facts side by side."
  );
  lines.push('');
  lines.push(
    'Happy to set up intro calls with any of these — just reply and let me know which ones catch your eye.'
  );
  lines.push('');
  lines.push('Warmly,');
  lines.push(ctx.expertName ? ctx.expertName.split(/\s+/)[0] : '[Your name]');

  return {
    subject,
    body: lines.join('\n'),
    camps,
    campsMissingSummary: camps
      .filter((c) => !c.summary)
      .map((c) => c.displayName),
  };
}

// ============================================================================
// Log to the deal
// ============================================================================

const HUBSPOT_API = 'https://api.hubapi.com';
const NOTE_TO_DEAL_TYPE_ID = 214;

/**
 * Record the composed email as a Note on the deal — the paper trail of what
 * was recommended, and a second place the rep can copy the text from.
 * Best-effort: a note failure must not fail the compose.
 */
export async function logEmailToDeal(
  dealId: string,
  email: ComposedEmail
): Promise<string | null> {
  const token = config.hubspot.accessToken;
  if (!token) return null;

  const body = {
    properties: {
      hs_timestamp: String(Date.now()),
      hs_note_body: `Recommendation email drafted (${email.camps.length} camp${
        email.camps.length === 1 ? '' : 's'
      }):\n\nSubject: ${email.subject}\n\n${email.body}`,
      },
    associations: [
      {
        to: { id: dealId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: NOTE_TO_DEAL_TYPE_ID,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[recommendation-email] failed to log note on deal ${dealId}:`,
        data?.message || res.status
      );
      return null;
    }
    return data?.id ? String(data.id) : null;
  } catch (err: any) {
    console.error(
      `[recommendation-email] note request failed for deal ${dealId}:`,
      err?.message
    );
    return null;
  }
}
