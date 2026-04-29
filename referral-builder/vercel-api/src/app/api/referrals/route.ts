/**
 * POST /api/referrals - Create or update a referral
 *
 * This endpoint uses the CreateReferralWorkflow for:
 * - Input validation
 * - Fetching Deal (for owner) and Company (for name)
 * - Canonical payload building with defaults + computed fields
 * - Upsert logic (create or update based on referral_key)
 * - Idempotent association creation (including labeled associations for Selected session)
 * - Structured error handling
 *
 * Request body:
 * {
 *   dealId: string (required)
 *   companyId: string (required)
 *   note?: string                     // referral_note_to_company
 *   outreachStatus?: string           // e.g., "Ready to Send", "Sent", "Resend"
 *   clientInterest?: string           // e.g., "Active / considering", "Selected"
 *   copiedFromDealKey?: string        // Set only if copied from prior-year deal
 *   copiedFromYear?: number           // Set only if copiedFromDealKey is set
 *   associateDealToCompany?: boolean
 * }
 *
 * Computed fields set on referral:
 * - hubspot_owner_id: from Deal.hubspot_owner_id
 * - resend_requested: true if outreachStatus == "Resend"
 *
 * Note: company_name is calculated by HubSpot from the associated Company.
 * Note: If any properties are read-only in HubSpot, they are automatically skipped.
 *
 * Response:
 * {
 *   ok: boolean
 *   referralId?: string
 *   created?: boolean
 *   updated?: boolean
 *   associationsCreated?: number
 *   associationsFailed?: number
 *   dealCompanyAssociated?: boolean
 *   errors?: string[]
 *   validationErrors?: string[]
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createReferralWorkflow } from '@/lib/workflow';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '@/lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

// ============================================================================
// Request Handling Utilities
// ============================================================================

/**
 * Extract HubSpot error details for user-friendly messages
 */
function extractHubSpotError(error: any): string {
  // HubSpot SDK errors often have nested structure
  if (error?.body?.message) {
    return error.body.message;
  }
  if (error?.response?.body?.message) {
    return error.response.body.message;
  }
  if (error?.message) {
    return error.message;
  }
  return 'Unknown error occurred';
}

/**
 * Create error response with consistent format
 */
function errorResponse(
  message: string,
  status: number,
  details?: { validationErrors?: string[]; errors?: string[] }
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: message,
      ...details,
    },
    { status }
  );
}

// ============================================================================
// Route Handler
// ============================================================================

export async function POST(req: NextRequest) {
  let body: unknown;

  // Debug: Log headers and content type
  console.log('[POST /api/referrals] Headers:', {
    contentType: req.headers.get('content-type'),
    contentLength: req.headers.get('content-length'),
    userAgent: req.headers.get('user-agent'),
  });

  // Read raw body once so we can both verify HubSpot's HMAC signature
  // and parse it as JSON (NextRequest body can only be consumed once).
  let rawBody = '';
  try {
    rawBody = await req.text();
    body = rawBody ? JSON.parse(rawBody) : {};
    console.log('[POST /api/referrals] Body parsed successfully, type:', typeof body);
  } catch (error: any) {
    console.error('[POST /api/referrals] JSON parse failed:', error.message);
    console.log(
      '[POST /api/referrals] Raw body:',
      rawBody.substring(0, 200)
    );
    return errorResponse('Invalid JSON in request body', 400);
  }

  // Log request (without sensitive data)
  console.log('[POST /api/referrals] Request received:', {
    dealId: (body as any)?.dealId,
    companyId: (body as any)?.companyId,
    hasNote: !!(body as any)?.note,
    outreachStatus: (body as any)?.outreachStatus,
    clientInterest: (body as any)?.clientInterest,
    associateDealToCompany: (body as any)?.associateDealToCompany,
  });

  // Authorization + commission_locked enforcement (spec §5.1, §6.1).
  //
  // /api/referrals doesn't have dealId in the path; it lives in the body.
  // Pull it through to both helpers. We pass [] as mutatingFields because
  // creating a referral row never writes any of the deal's sacred fields
  // — referral creation is a non-sacred mutation that should pass through
  // even on a locked deal. requireUnlocked short-circuits on empty fields.
  const dealIdFromBody = String((body as any)?.dealId ?? '');
  if (dealIdFromBody) {
    try {
      await requireDealAuthorization(req, dealIdFromBody, rawBody);
      await requireUnlocked(dealIdFromBody, []);
    } catch (err) {
      if (err instanceof DealAuthorizationError) {
        return NextResponse.json(err.body, { status: err.statusCode });
      }
      if (err instanceof RequireUnlockedError) {
        return NextResponse.json(err.body, { status: err.statusCode });
      }
      throw err;
    }
  }

  try {
    // Execute workflow
    const result = await createReferralWorkflow(body);

    if (!result.success) {
      // Validation failed
      if (result.validationErrors) {
        return errorResponse(
          'Validation failed',
          400,
          { validationErrors: result.validationErrors }
        );
      }

      // Other workflow errors
      return errorResponse(
        result.errors?.[0] || 'Failed to create referral',
        500,
        { errors: result.errors }
      );
    }

    // Success response
    const response = {
      ok: true,
      referralId: result.referralId,
      created: result.created,
      updated: result.updated,
      associationsCreated: result.associationsCreated,
      associationsFailed: result.associationsFailed,
      dealCompanyAssociated: result.dealCompanyAssociated,
    };

    // Include non-critical errors if any
    if (result.errors && result.errors.length > 0) {
      (response as any).warnings = result.errors;
    }

    console.log('[POST /api/referrals] Success:', response);
    return NextResponse.json(response);
  } catch (error: any) {
    // Unexpected errors
    const errorMessage = extractHubSpotError(error);
    console.error('[POST /api/referrals] Unexpected error:', errorMessage);

    return errorResponse(
      `Server error: ${errorMessage}`,
      500,
      { errors: [errorMessage] }
    );
  }
}
