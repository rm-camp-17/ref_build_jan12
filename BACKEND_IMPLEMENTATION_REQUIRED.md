# Backend Implementation Requirements

## Overview
The improved frontend requires backend changes to fully support all features. This document outlines what needs to be implemented in the Vercel API backend.

---

## 1. POST /api/referrals - Enhanced Payload

### Current Expected Payload (from README):
```typescript
{
  "dealId": "12345",
  "companyId": "67890",
  "programId": "11111",      // optional
  "sessionId": "33333",      // optional
  "note": "text",            // optional
  "outreachStatus": "Draft",
  "clientInterest": "Active / considering"
}
```

### NEW Required Payload:
```typescript
{
  "dealId": "12345",
  "companyId": "67890",
  "programId": "11111",                    // optional
  "sessionId": "33333",                    // optional
  "note": "text",                          // optional
  "outreachStatus": "ready_to_send",       // ✅ REQUIRED - internal value
  "clientInterest": "active_considering",  // ✅ REQUIRED - internal value
  "associateToDeal": true                  // ✅ NEW - flag to create Deal↔Company assoc
}
```

### Implementation Pseudocode:

```typescript
// File: vercel-api/src/app/api/referrals/route.ts

import { NextRequest, NextResponse } from "next/server";
import { hubspotClient } from "@/lib/hubspot";
import { createAssociation } from "@/lib/associations";

export async function POST(req: NextRequest) {
  const body = await req.json();

  const {
    dealId,
    companyId,
    programId,
    sessionId,
    note,
    outreachStatus,     // NEW REQUIRED
    clientInterest,     // NEW REQUIRED
    associateToDeal,    // NEW FLAG
  } = body;

  // Validation
  if (!dealId || !companyId) {
    return NextResponse.json(
      { error: "dealId and companyId are required" },
      { status: 400 }
    );
  }

  if (!outreachStatus || !clientInterest) {
    return NextResponse.json(
      { error: "outreachStatus and clientInterest are required" },
      { status: 400 }
    );
  }

  // Build referral properties
  const properties = {
    referral_key: `${dealId}-${companyId}`,
    referral_status: outreachStatus,           // Use internal value
    client_interest: clientInterest,           // Use internal value
    referral_note_to_company: note || "",
    referral_name: `Referral for Deal ${dealId}`,
    // ... other auto-managed properties
  };

  // 1. Create or update referral (upsert logic)
  let referralId: string;
  let created = false;

  try {
    // Search for existing referral by key
    const searchResults = await hubspotClient.crm.objects.searchApi.doSearch(
      process.env.HS_REFERRAL_OBJECT_TYPE || "p_referral",
      {
        filterGroups: [{
          filters: [{
            propertyName: "referral_key",
            operator: "EQ",
            value: properties.referral_key,
          }],
        }],
        limit: 1,
      }
    );

    if (searchResults.results.length > 0) {
      // Update existing
      referralId = searchResults.results[0].id;
      await hubspotClient.crm.objects.basicApi.update(
        process.env.HS_REFERRAL_OBJECT_TYPE || "p_referral",
        referralId,
        { properties }
      );
      created = false;
    } else {
      // Create new
      const createResult = await hubspotClient.crm.objects.basicApi.create(
        process.env.HS_REFERRAL_OBJECT_TYPE || "p_referral",
        { properties }
      );
      referralId = createResult.id;
      created = true;
    }
  } catch (error: any) {
    console.error("Failed to create/update referral:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create referral" },
      { status: 500 }
    );
  }

  // 2. Create associations
  try {
    const associationsToCreate = [
      { fromType: "referral", toType: "deals", toId: dealId },
      { fromType: "referral", toType: "companies", toId: companyId },
    ];

    if (programId) {
      associationsToCreate.push({
        fromType: "referral",
        toType: "program",
        toId: programId,
      });
    }

    if (sessionId) {
      associationsToCreate.push({
        fromType: "referral",
        toType: "session",
        toId: sessionId,
      });
    }

    for (const assoc of associationsToCreate) {
      await createAssociation(
        referralId,
        assoc.fromType,
        assoc.toId,
        assoc.toType
      );
    }
  } catch (error: any) {
    console.error("Failed to create associations:", error);
    // Don't fail the entire request if associations fail
  }

  // 3. ✅ NEW: Create Deal↔Company association if requested
  if (associateToDeal === true) {
    try {
      await hubspotClient.crm.associations.batchApi.create({
        inputs: [{
          from: { id: dealId },
          to: { id: companyId },
          types: [{
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 3, // Deal to Company
          }],
        }],
      });
      console.log(`Created Deal↔Company association: ${dealId} ↔ ${companyId}`);
    } catch (error: any) {
      console.error("Failed to create Deal↔Company association:", error);
      // Don't fail the entire request
    }
  }

  return NextResponse.json({
    ok: true,
    referralId,
    created,
    updated: !created,
  });
}
```

---

## 2. GET /api/deals/{dealId}/referrals - Return Created Timestamp

### Current Response:
```typescript
{
  "results": [{
    "id": "12345",
    "referralKey": "...",
    "outreachStatus": "Draft",
    "clientInterest": "Active / considering",
    "note": "...",
    "company": { "id": "...", "name": "..." },
    "program": { "id": "...", "name": "..." },
    "session": { "id": "...", "name": "..." }
  }]
}
```

### NEW Required Response:
```typescript
{
  "results": [{
    "id": "12345",
    "referralKey": "...",
    "outreachStatus": "ready_to_send",      // Internal value
    "clientInterest": "active_considering", // Internal value
    "note": "...",
    "createdAt": "2026-01-13T10:30:00.000Z", // ✅ ADD THIS
    "company": { "id": "...", "name": "..." },
    "program": { "id": "...", "name": "..." },
    "session": {
      "id": "...",
      "name": "...",
      "startDate": "2025-06-01",
      // ...
    }
  }]
}
```

### Implementation:
```typescript
// File: vercel-api/src/app/api/deals/[dealId]/referrals/route.ts

// When fetching referrals, include createdAt property
const referrals = await hubspotClient.crm.objects.basicApi.getPage(
  process.env.HS_REFERRAL_OBJECT_TYPE || "p_referral",
  {
    limit: 100,
    properties: [
      "referral_key",
      "referral_status",
      "client_interest",
      "referral_note_to_company",
      "hs_createdate", // ✅ HubSpot's created timestamp
    ],
    // ... associations ...
  }
);

// Map to response format
const results = referrals.results.map((r) => ({
  id: r.id,
  referralKey: r.properties.referral_key,
  outreachStatus: r.properties.referral_status,
  clientInterest: r.properties.client_interest,
  note: r.properties.referral_note_to_company,
  createdAt: r.properties.hs_createdate, // ✅ Return created timestamp
  // ... company, program, session ...
}));
```

---

## 3. HubSpot Property Values Verification

### CRITICAL: Verify Internal Values

The frontend uses these internal values:
- **Referral Status**: `draft`, `ready_to_send`, `sent`, `resend`, `dont_send`
- **Client Interest**: `active_considering`, `shortlist`, `neutral`, `unlikely`, `declined`, `selected`

**You MUST verify these match HubSpot's actual internal values.**

### How to Verify:

**Option 1: Via HubSpot UI**
1. Go to Settings → Objects → Referral
2. Click on "Properties"
3. Find "Referral Status" property
4. Click "Edit"
5. Check the "Internal value" for each option (not the "Label")

**Option 2: Via API**
```typescript
// File: vercel-api/src/app/api/referrals/properties/route.ts

import { NextResponse } from "next/server";
import { hubspotClient } from "@/lib/hubspot";

export async function GET() {
  try {
    const objectType = process.env.HS_REFERRAL_OBJECT_TYPE || "p_referral";

    // Fetch property definitions
    const [statusProp, interestProp] = await Promise.all([
      hubspotClient.crm.properties.coreApi.getByName(
        objectType,
        "referral_status"
      ),
      hubspotClient.crm.properties.coreApi.getByName(
        objectType,
        "client_interest"
      ),
    ]);

    // Extract options with INTERNAL values
    const properties = {
      referral_status: {
        name: statusProp.name,
        label: statusProp.label,
        options: statusProp.options?.map((opt) => ({
          label: opt.label,
          value: opt.value, // ✅ This is the internal value
        })) || [],
      },
      client_interest: {
        name: interestProp.name,
        label: interestProp.label,
        options: interestProp.options?.map((opt) => ({
          label: opt.label,
          value: opt.value, // ✅ This is the internal value
        })) || [],
      },
    };

    return NextResponse.json({ properties });
  } catch (error: any) {
    console.error("Failed to load properties:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
```

### If Internal Values Differ:

Update the frontend defaults in `ReferralBuilderCard.tsx`:

```typescript
// Lines 38-56
const DEFAULT_OUTREACH_OPTIONS: Option[] = [
  { label: "Draft", value: "THE_ACTUAL_INTERNAL_VALUE" }, // ← Update this
  // ...
];
```

---

## 4. Association Type IDs

### Deal ↔ Company Association

The association type ID for Deal → Company is typically `3`, but this can vary.

### How to Find the Correct Association Type ID:

```typescript
// Fetch association types dynamically
const associationTypes = await hubspotClient.crm.associations.schemaApi.getAll(
  "deals",
  "companies"
);

// Find the correct type (usually "Deal to Company" or similar)
const dealToCompanyType = associationTypes.results.find(
  (type) => type.label === "Deal to Company"
);

const associationTypeId = dealToCompanyType?.typeId || 3; // Fallback to 3
```

### Recommended: Cache Association Type IDs

```typescript
// File: vercel-api/src/lib/associations.ts

let cachedAssociationTypes: Record<string, number> = {};

export async function getAssociationTypeId(
  fromObjectType: string,
  toObjectType: string,
  label?: string
): Promise<number> {
  const cacheKey = `${fromObjectType}-${toObjectType}`;

  if (cachedAssociationTypes[cacheKey]) {
    return cachedAssociationTypes[cacheKey];
  }

  const types = await hubspotClient.crm.associations.schemaApi.getAll(
    fromObjectType,
    toObjectType
  );

  // If label provided, find by label; otherwise use first
  const matchingType = label
    ? types.results.find((t) => t.label === label)
    : types.results[0];

  if (!matchingType) {
    throw new Error(
      `No association type found for ${fromObjectType} → ${toObjectType}`
    );
  }

  cachedAssociationTypes[cacheKey] = matchingType.typeId;
  return matchingType.typeId;
}
```

---

## 5. Testing Checklist

- [ ] POST /api/referrals accepts `outreachStatus` and `clientInterest`
- [ ] POST /api/referrals validates these fields are present
- [ ] POST /api/referrals accepts `associateToDeal` flag
- [ ] When `associateToDeal: true`, creates Deal↔Company association
- [ ] GET /api/deals/{dealId}/referrals returns `createdAt` timestamp
- [ ] GET /api/referrals/properties returns correct internal values
- [ ] Frontend default values match HubSpot internal values
- [ ] Error responses include detailed validation messages
- [ ] Test on Deal 53695922718 (no company scenario)
- [ ] Test on deal with existing company

---

## 6. Environment Variables

Ensure these are set in Vercel:

```env
HUBSPOT_ACCESS_TOKEN=pat-na1-...
HS_PROGRAM_OBJECT_TYPE=p_program
HS_SESSION_OBJECT_TYPE=p_session
HS_REFERRAL_OBJECT_TYPE=p_referral
HS_REFERRAL_KEY_PROP=referral_key
HS_REFERRAL_OUTREACH_PROP=referral_status
HS_REFERRAL_INTEREST_PROP=client_interest
HS_REFERRAL_NOTE_PROP=referral_note_to_company
HS_REFERRAL_NAME_PROP=referral_name
```

---

## 7. HubSpot API Client Setup

```typescript
// File: vercel-api/src/lib/hubspot.ts

import { Client } from "@hubspot/api-client";

const hubspotClient = new Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
});

export { hubspotClient };
```

---

## 8. Error Response Format

Ensure all API endpoints return consistent error format:

```typescript
// 400 - Validation Error
{
  "error": "Missing required field: outreachStatus",
  "errors": [
    { "field": "outreachStatus", "message": "This field is required" }
  ]
}

// 500 - Server Error
{
  "error": "Failed to create referral",
  "message": "Detailed error message from HubSpot API"
}
```

Frontend will extract and display these messages to the user.

---

## Summary

1. ✅ Add `outreachStatus`, `clientInterest`, `associateToDeal` to POST /api/referrals
2. ✅ Implement Deal↔Company association creation when `associateToDeal: true`
3. ✅ Return `createdAt` timestamp in GET /api/deals/{dealId}/referrals
4. ✅ Verify HubSpot property internal values match frontend defaults
5. ✅ Use dynamic association type ID fetching
6. ✅ Return detailed error messages in responses
7. ✅ Test all scenarios from the test plan

---

## Quick Start

1. Update `vercel-api/src/app/api/referrals/route.ts` with the POST handler code above
2. Update `vercel-api/src/app/api/deals/[dealId]/referrals/route.ts` to include `createdAt`
3. Verify property internal values via GET /api/referrals/properties
4. Deploy to Vercel: `vercel --prod`
5. Test the frontend with the improved UI component
