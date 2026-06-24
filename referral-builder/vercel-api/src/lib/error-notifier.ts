/**
 * Pipeline-failure alerting (item 7).
 *
 * When a pipeline action fails — a stage that won't move, a submit that
 * errors out — we notify the admin with the record, the action attempted,
 * and the exact error so they can troubleshoot.
 *
 * Delivery:
 *   1. Resend (transactional email) when RESEND_API_KEY is configured.
 *   2. Fallback: a HubSpot task assigned to the admin owner with an
 *      immediate reminder (which generates an email notification). Used
 *      when Resend isn't configured or the send fails.
 *
 * This module NEVER throws into the request path — alerting is best-effort
 * and must not turn one failure into two. Call it and move on (no await
 * needed if you don't care about ordering, but awaiting is fine — it
 * swallows its own errors).
 */

import { config } from './config';
import { hubspotClient } from './hubspot';

export interface PipelineFailure {
  /** The action that failed, e.g. "advance-stage", "select-session". */
  action: string;
  /** Exact error message / detail. */
  error: string;
  dealId?: string;
  referralId?: string;
  /** Optional extra context (target stage, request body, etc.). */
  detail?: string;
}

/**
 * Best-effort: alert the admin about a failed pipeline action. Resolves
 * (never rejects) regardless of whether delivery succeeded.
 */
export async function notifyPipelineFailure(
  failure: PipelineFailure
): Promise<void> {
  try {
    const subject =
      `[Referral Builder] Pipeline failure: ${failure.action}` +
      (failure.dealId ? ` (deal ${failure.dealId})` : '');
    const text = buildBody(failure);

    const emailed = await trySendResend(subject, text);
    if (!emailed) {
      await createTaskFallback(subject, text, failure.dealId);
    }
  } catch (err: any) {
    // Alerting must never escalate a failure. Log and swallow.
    console.error(
      '[notify] could not deliver pipeline-failure alert:',
      err?.message ?? err
    );
  }
}

function buildBody(f: PipelineFailure): string {
  const portal = config.notifications.portalId;
  const dealUrl = f.dealId
    ? `https://app.hubspot.com/contacts/${portal}/deal/${f.dealId}`
    : null;
  return [
    'A pipeline action failed in the Referral Builder card.',
    '',
    `Action attempted : ${f.action}`,
    f.dealId ? `Deal             : ${f.dealId}` : null,
    dealUrl ? `Deal link        : ${dealUrl}` : null,
    f.referralId ? `Referral         : ${f.referralId}` : null,
    `Error            : ${f.error}`,
    f.detail ? `Detail           : ${f.detail}` : null,
    `Time (UTC)       : ${new Date().toISOString()}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Returns true if the email was accepted by Resend. */
async function trySendResend(subject: string, text: string): Promise<boolean> {
  const key = config.notifications.resendApiKey;
  if (!key) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.notifications.resendFrom,
        to: [config.notifications.adminEmail],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      console.error(`[notify] Resend responded ${res.status}; will fall back.`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[notify] Resend send failed; will fall back:', err?.message ?? err);
    return false;
  }
}

/**
 * Fallback when Resend isn't available: create a HubSpot task assigned to
 * the admin with an immediate reminder, associated to the deal when known.
 * The immediate reminder makes HubSpot send the admin an email/notification.
 */
async function createTaskFallback(
  subject: string,
  text: string,
  dealId?: string
): Promise<void> {
  const now = String(Date.now());
  const properties: Record<string, string> = {
    hs_task_subject: subject,
    hs_task_body: text,
    hs_timestamp: now,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_task_type: 'TODO',
    hubspot_owner_id: config.notifications.adminOwnerId,
    // Immediate reminder → HubSpot fires a notification/email to the owner.
    hs_task_reminders: now,
  };

  const created = await hubspotClient.crm.objects.basicApi.create('tasks', {
    properties,
    associations: [],
  });

  if (dealId) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'tasks',
        created.id,
        'deals',
        dealId
      );
    } catch (err: any) {
      console.warn(
        `[notify] task ${created.id} created but could not associate to deal ${dealId}:`,
        err?.message ?? err
      );
    }
  }
}
