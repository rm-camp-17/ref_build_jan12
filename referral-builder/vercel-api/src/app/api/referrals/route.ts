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
 *   programId?: string
 *   sessionId?: string                // Single session (backwards compatible)
 *   sessionIds?: string[]             // Multiple sessions support
 *   selectedBillingSessionId?: string // Billing session when clientInterest == "Selected"
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
 * - selected_session_start_date, selected_session_end_date, selected_session_price:
 *   Only set when clientInterest == "Selected" AND selectedBillingSessionId provided
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

  // Parse request body
  try {
    body = await req.json();
    console.log('[POST /api/referrals] Body parsed successfully, type:', typeof body);
  } catch (error: any) {
    console.error('[POST /api/referrals] JSON parse failed:', error.message);

    // Try to read raw body for debugging
    try {
      const clone = req.clone();
      const text = await clone.text();
      console.log('[POST /api/referrals] Raw body:', text.substring(0, 200));
    } catch (e) {
      console.error('[POST /api/referrals] Could not read raw body');
    }

    return errorResponse('Invalid JSON in request body', 400);
  }

  // Log request (without sensitive data)
  console.log('[POST /api/referrals] Request received:', {
    dealId: (body as any)?.dealId,
    companyId: (body as any)?.companyId,
    programId: (body as any)?.programId,
    sessionId: (body as any)?.sessionId,
    hasNote: !!(body as any)?.note,
    outreachStatus: (body as any)?.outreachStatus,
    clientInterest: (body as any)?.clientInterest,
    associateDealToCompany: (body as any)?.associateDealToCompany,
  });

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
