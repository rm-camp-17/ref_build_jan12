# Referral Builder - Bug Fix & Enhancement Documentation

## Executive Summary

This document outlines the root causes of the 400 error bug, the implemented fixes, and comprehensive test plans for the improved Referral Builder HubSpot UI Extension.

---

## 🐛 ROOT CAUSE ANALYSIS

### 1. Missing Required Fields in Create Payload
**Location**: `ReferralBuilderCard.tsx:185-220` (original `createReferral()` function)

**Issue**:
- The create payload only included: `dealId`, `companyId`, `programId`, `sessionId`, `note`
- According to the API documentation (README.md line 516), the POST `/api/referrals` endpoint expects `outreachStatus` and `clientInterest` fields
- These fields are likely **required** by the backend validation, causing the 400 error

**Evidence**:
```typescript
// ORIGINAL (lines 189-196)
const payload = {
  dealId,
  companyId: selectedCompanyId,
  programId: selectedProgramId || undefined,
  sessionId: selectedSessionId || undefined,
  note: note || undefined,
  // ❌ Missing: outreachStatus, clientInterest
};
```

**Impact**: Backend rejects the request with 400 Bad Request

---

### 2. No Deal Company Pre-Selection Logic
**Location**: Missing functionality in original code

**Issue**:
- The UI never fetches the deal's associated companies on load
- Cannot pre-select company if deal already has one
- User must manually search and select even if company is already associated

**What's Missing**:
- No call to HubSpot CRM API: `GET /crm/v4/objects/deals/{dealId}?associations=companies`
- No state variable to track deal's existing companies
- No auto-population of company selector

**Impact**: Poor UX - unnecessary steps for user

---

### 3. No Deal↔Company Association Creation
**Location**: Missing functionality in original code

**Issue**:
- When creating a referral for a deal with no associated company, the code doesn't create the Deal↔Company association
- User requirement: "If the deal has no associated company, on create we should also associate the selected company to the deal"

**What's Missing**:
- No checkbox UI to indicate intent
- No API call to HubSpot: `PUT /crm/v4/objects/deals/{dealId}/associations/companies/{companyId}`
- Or backend endpoint doesn't handle the `associateToDeal` flag

**Impact**: Deal remains without company; future loads will have same issue

---

### 4. Property Value Mismatch (Potential Issue)
**Location**: `ReferralBuilderCard.tsx:31-46` (default options)

**Issue**:
- The code uses label values directly: `"Draft"`, `"Active / considering"`, etc.
- HubSpot often has **different internal values** vs. **display labels**
  - Example: Label = "Ready to Send", Internal Value = "ready_to_send"
- If backend expects internal values, using labels causes 400 validation error

**Current State**:
```typescript
// ORIGINAL default options
const DEFAULT_OUTREACH_OPTIONS: Option[] = [
  { label: "Draft", value: "Draft" },  // ❌ Using label as value
  { label: "Ready to Send", value: "Ready to Send" },
  // ...
];
```

**Risk**: If HubSpot property options use different internal values (e.g., lowercase, underscored), this will fail

---

### 5. Poor Error Handling
**Location**: `ReferralBuilderCard.tsx:106-108`

**Issue**:
```typescript
if (!res.ok) {
  const msg = data?.error || data?.message || `Request failed (${res.status})`;
  throw new Error(msg);
}
```

- Only extracts simple `error` or `message` field
- HubSpot API errors often have rich structure:
  - `data.errors[]` - array of validation errors
  - `data.error.message` - nested error object
- User sees generic "Request failed (400)" instead of actionable error like "Property 'referral_status': Invalid value 'Draft'. Valid values: draft, ready_to_send"

**Impact**: Cannot debug issues without checking Vercel backend logs

---

### 6. Layout and UX Issues
**Issues**:
- Single-column layout (hard to see both form and existing referrals)
- Referrals list lacks important details (created date, formatted display)
- No loading indicators during API calls
- No disabled state on Create button during submission (allows double-submit)

---

## ✅ IMPLEMENTED FIXES

### File: `ReferralBuilderCard_IMPROVED.tsx`

### Fix 1: Add Default Values for Status and Interest
**Lines**: 47-50, 90-91, 330-341

**Changes**:
```typescript
// Define defaults with INTERNAL VALUES (not labels)
const DEFAULT_REFERRAL_STATUS = "ready_to_send"; // "Ready to Send"
const DEFAULT_CLIENT_INTEREST = "active_considering"; // "Active / considering"

// State to track selected values
const [selectedOutreachStatus, setSelectedOutreachStatus] = useState<string>(DEFAULT_REFERRAL_STATUS);
const [selectedClientInterest, setSelectedClientInterest] = useState<string>(DEFAULT_CLIENT_INTEREST);

// In createReferral(), include in payload:
const payload = {
  dealId,
  companyId: selectedCompanyId,
  programId: selectedProgramId || undefined,
  sessionId: selectedSessionId || undefined,
  note: note || undefined,
  // ✅ NOW INCLUDED:
  outreachStatus: selectedOutreachStatus,
  clientInterest: selectedClientInterest,
  associateToDeal: showAssociateCheckbox && associateToDeal,
};
```

**Why This Fixes 400 Error**:
- Backend now receives required `outreachStatus` and `clientInterest` fields
- Uses internal values that match HubSpot property options

---

### Fix 2: Pre-Select Company from Deal Associations
**Lines**: 151-186

**Changes**:
```typescript
// New state
const [dealCompanies, setDealCompanies] = useState<DealCompany[]>([]);

// New function to fetch deal's associated companies
async function loadDealCompanies() {
  if (!dealId) return;

  try {
    // Fetch deal with company associations
    const data = await hubspotCrmRequest(
      `/crm/v4/objects/deals/${dealId}?associations=companies`
    );

    const companies: DealCompany[] = [];

    if (data?.associations?.companies?.results) {
      for (const assoc of data.associations.companies.results) {
        // Fetch company details
        const companyData = await hubspotCrmRequest(
          `/crm/v3/objects/companies/${assoc.toObjectId}?properties=name`
        );
        companies.push({
          id: assoc.toObjectId,
          name: companyData?.properties?.name || `Company ${assoc.toObjectId}`,
        });
      }
    }

    setDealCompanies(companies);

    // Pre-select company if there's exactly one
    if (companies.length === 1 && !selectedCompanyId) {
      setSelectedCompanyId(companies[0].id);
      // Load programs for pre-selected company
      await loadPrograms(companies[0].id);
    }
  } catch (e: any) {
    console.error("Failed to load deal companies:", e);
  }
}
```

**UX Improvement**:
- If deal has 1 company: auto-selected, programs auto-loaded
- If deal has 0 companies: user can search and select
- If deal has multiple companies: user can see them, choose to search for different one

---

### Fix 3: Checkbox to Associate Company to Deal
**Lines**: 75-76, 459-466

**Changes**:
```typescript
// State
const [associateToDeal, setAssociateToDeal] = useState(true); // Default ON

// Show checkbox only if deal has no company AND user selected one
const showAssociateCheckbox = !dealHasCompany && selectedCompanyId;

// UI (in create form)
{showAssociateCheckbox && (
  <Checkbox
    name="associateToDeal"
    checked={associateToDeal}
    onChange={(checked: boolean) => setAssociateToDeal(checked)}
    label="Also associate this company to the deal"
    description="This deal has no associated company. Check this to create the association."
  />
)}

// Payload includes flag
associateToDeal: showAssociateCheckbox && associateToDeal,
```

**Backend Requirement**:
The backend `/api/referrals` POST handler must check for `associateToDeal: true` and call:
```typescript
// Pseudo-code for backend
if (payload.associateToDeal) {
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
}
```

---

### Fix 4: Use Internal Values for Property Options
**Lines**: 38-56

**Changes**:
```typescript
// IMPROVED - Use internal values (lowercase, underscored)
const DEFAULT_OUTREACH_OPTIONS: Option[] = [
  { label: "Draft", value: "draft" },
  { label: "Ready to Send", value: "ready_to_send" },
  { label: "Sent", value: "sent" },
  { label: "Resend", value: "resend" },
  { label: "Don't send (already sent)", value: "dont_send" },
];

const DEFAULT_INTEREST_OPTIONS: Option[] = [
  { label: "Active / considering", value: "active_considering" },
  { label: "Shortlist", value: "shortlist" },
  { label: "Neutral", value: "neutral" },
  { label: "Unlikely", value: "unlikely" },
  { label: "Declined", value: "declined" },
  { label: "Selected", value: "selected" },
];
```

**Note**: These values are **assumptions**. The actual internal values should be verified by:
1. Loading from `/api/referrals/properties` endpoint (already implemented at line 211)
2. OR checking HubSpot UI: Settings → Objects → Referral → Properties → referral_status → Options

---

### Fix 5: Enhanced Error Handling
**Lines**: 103-136

**Changes**:
```typescript
async function apiRequest(path: string, init?: { method?: string; body?: any }) {
  const url = `${API_BASE}${path}`;
  // ... fetch logic ...

  if (!res.ok) {
    // Enhanced error extraction
    let msg = `Request failed (${res.status})`;

    if (data?.error) {
      // Handle string or object error
      msg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    } else if (data?.message) {
      msg = data.message;
    } else if (data?.errors && Array.isArray(data.errors)) {
      // HubSpot validation errors
      msg = data.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
    }

    throw new Error(msg);
  }
  return data;
}
```

**Benefit**: User sees actual validation error like:
- "Property 'referral_status': Invalid option value"
- "Missing required property: client_interest"
- Instead of generic "Request failed (400)"

---

### Fix 6: Two-Column Layout & Improved Referrals List
**Lines**: 405-598

**Changes**:
```typescript
{/* TWO-COLUMN LAYOUT */}
<Flex direction="row" gap="lg" wrap="wrap">

  {/* LEFT COLUMN: CREATE FORM */}
  <Box flex={1} style={{ minWidth: "300px" }}>
    {/* ... create form ... */}
  </Box>

  {/* RIGHT COLUMN: EXISTING REFERRALS */}
  <Box flex={1} style={{ minWidth: "300px" }}>
    <Heading level="h3">Existing Referrals</Heading>
    {/* Enhanced referrals list with:
      - Company/Program/Session names
      - Created date
      - Better visual separation
      - Loading states
      - Empty state
    */}
  </Box>
</Flex>
```

**Referral Card Enhancements**:
- Show created date: `Created: 01/13/2026`
- Show session start date: `Session 1 (2025-06-01)`
- Boxed layout with borders for visual separation
- "Refresh" button with loading spinner
- Empty state component when no referrals

---

### Fix 7: Prevent Double Submits
**Lines**: 78, 491

**Changes**:
```typescript
const canCreate = useMemo(() => {
  return Boolean(dealId && selectedCompanyId && !busy);
}, [dealId, selectedCompanyId, busy]);

// Button disabled during submission
<Button
  variant="primary"
  disabled={!canCreate}
  onClick={async () => {
    setBusy(true);
    await createReferral();
    setBusy(false);
  }}
>
  {busy ? "Creating..." : "Create Referral"}
</Button>
```

---

### Fix 8: Program/Session Display Names
**Already Correct in Original**

**Lines**: 252-270 (loadPrograms), 272-287 (loadSessions)

The original code already displays names:
```typescript
const opts: Option[] = (data?.results || []).map((p: any) => ({
  label: p.name || `Program ${p.id}`, // ✅ Displays name
  value: String(p.id),                // ✅ Stores ID
}));
```

**No change needed** - this was already working correctly.

---

## 🎨 NEW UI FEATURES

### 1. Default Selections for New Referrals
- **Referral Status**: Defaults to "Ready to Send" (pre-selected in dropdown)
- **Client Interest**: Defaults to "Active / considering" (pre-selected in dropdown)
- User can change before creating

### 2. Company Association UX
- If deal has 1 company: **auto-selected**
- If deal has 0 companies: **show checkbox** "Also associate this company to the deal" (default ON)
- If deal has multiple companies: **display at top**, user can still search for different one

### 3. Loading States
- Initial load: Full-screen spinner with "Loading Referral Builder..."
- During operations: "Creating...", "Loading...", disabled buttons

### 4. Better Alerts
- Success: "Referral created successfully (ID 12345)"
- Error: Detailed HubSpot validation message

### 5. Enhanced Referrals List
- Company name (bold)
- Program name
- Session name + start date
- Created date (formatted)
- All editable fields (status, interest, note)
- "Save Changes" button per referral

---

## 🧪 TEST PLAN

### Prerequisites
1. Deploy improved code:
   ```bash
   cd /home/user/ref_build_jan12/referral-builder/hubspot-card
   cp src/app/cards/ReferralBuilderCard_IMPROVED.tsx src/app/cards/ReferralBuilderCard.tsx
   hs project upload
   ```

2. Ensure backend supports:
   - `outreachStatus` and `clientInterest` in POST `/api/referrals` payload
   - `associateToDeal` flag to create Deal↔Company association
   - Returns `createdAt` timestamp in referral objects

---

### Test Case 1: Deal with NO Associated Company (Bug Scenario)
**Deal ID**: 53695922718 (from bug report)

**Steps**:
1. Open Deal 53695922718 in HubSpot
2. Navigate to Referral Builder card
3. **Verify**:
   - ✅ No company shown at top
   - ✅ "Search company" field is empty
   - ✅ Create button is disabled

4. Search for "forest" → Select "FOREST LAKE"
5. **Verify**:
   - ✅ Checkbox appears: "Also associate this company to the deal"
   - ✅ Checkbox is checked by default
   - ✅ Programs load automatically
   - ✅ Create button is enabled

6. Select Program: 40059681208
7. Select Session: 40029567619
8. **Verify**:
   - ✅ Referral Status dropdown shows "Ready to Send" selected
   - ✅ Client Interest dropdown shows "Active / considering" selected

9. Enter Note: "asdfdasf"
10. Click "Create Referral"
11. **Verify**:
    - ✅ Button shows "Creating..." and is disabled
    - ✅ No warning about missing company
    - ✅ Request succeeds (no 400 error)
    - ✅ Success toast: "Referral created successfully (ID xxxxx)"
    - ✅ Form clears
    - ✅ Referrals list refreshes and shows new referral
    - ✅ Top of card now shows "Company: FOREST LAKE"

12. Refresh page, verify:
    - ✅ "FOREST LAKE" is pre-selected in company dropdown
    - ✅ Programs are loaded automatically
    - ✅ Checkbox does NOT appear (deal now has company)

---

### Test Case 2: Deal with Existing Associated Company
**Deal ID**: Any deal with an associated company

**Steps**:
1. Open deal in HubSpot
2. Navigate to Referral Builder card
3. **Verify**:
   - ✅ Company name shown at top: "Company: [Name]"
   - ✅ Company is pre-selected in dropdown
   - ✅ Programs are loaded automatically
   - ✅ No checkbox shown

4. Select different program, session
5. Change Referral Status to "Draft"
6. Change Client Interest to "Shortlist"
7. Add note
8. Click "Create Referral"
9. **Verify**:
   - ✅ Creates successfully
   - ✅ New referral shows in list with correct values

---

### Test Case 3: Update Existing Referral
**Steps**:
1. Open deal with existing referrals
2. In the Existing Referrals section (right column), select a referral
3. Change "Status" to "Sent"
4. Change "Client Interest" to "Selected"
5. Edit note
6. Click "Save Changes"
7. **Verify**:
   - ✅ Shows "Referral updated successfully"
   - ✅ List refreshes with new values
   - ✅ Values persist after page refresh

---

### Test Case 4: Error Handling
**Steps**:
1. Open network throttling in browser DevTools (simulate slow connection)
2. Create a referral
3. **Verify**:
   - ✅ Button disabled during request
   - ✅ Shows "Creating..."
   - ✅ Cannot click button again

4. Cause an error (e.g., manually edit network request to send invalid data)
5. **Verify**:
   - ✅ Shows detailed error message (not just "400")
   - ✅ Form doesn't clear
   - ✅ User can fix and retry

---

### Test Case 5: Multiple Companies on Deal
**Deal ID**: Deal with 2+ associated companies

**Steps**:
1. Open deal
2. **Verify**:
   - ✅ Shows "Company: Company A, Company B" at top
   - ✅ First company is pre-selected
   - ✅ User can search and select different company
   - ✅ No checkbox shown

---

### Test Case 6: Refresh Referrals List
**Steps**:
1. Open deal with referrals
2. Click "Refresh" button in Existing Referrals section
3. **Verify**:
   - ✅ Shows loading spinner
   - ✅ List refreshes
   - ✅ Button disabled during load

---

## 🔧 BACKEND REQUIREMENTS

The improved frontend assumes the backend (`/api/referrals` POST endpoint) supports:

### 1. Accept Additional Payload Fields
```typescript
POST /api/referrals
{
  "dealId": "12345",
  "companyId": "67890",
  "programId": "11111",        // optional
  "sessionId": "33333",        // optional
  "note": "text",              // optional
  "outreachStatus": "ready_to_send",     // ✅ NEW REQUIRED
  "clientInterest": "active_considering", // ✅ NEW REQUIRED
  "associateToDeal": true      // ✅ NEW (flag to create Deal↔Company assoc)
}
```

### 2. Create Deal↔Company Association
If `associateToDeal: true`, backend should:
```typescript
// Use HubSpot Associations API
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
```

### 3. Return Created Timestamp
```typescript
// Response should include
{
  "ok": true,
  "referralId": "12345",
  "created": true,
  "createdAt": "2026-01-13T10:30:00.000Z" // ✅ Add this
}
```

### 4. GET /api/deals/{dealId}/referrals Should Return
```typescript
{
  "results": [{
    "id": "12345",
    "referralKey": "...",
    "outreachStatus": "ready_to_send",
    "clientInterest": "active_considering",
    "note": "...",
    "createdAt": "2026-01-13T10:30:00.000Z", // ✅ Include this
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

---

## 📋 DEPLOYMENT CHECKLIST

- [ ] Verify internal values for `referral_status` and `client_interest` properties in HubSpot
- [ ] Update `DEFAULT_OUTREACH_OPTIONS` and `DEFAULT_INTEREST_OPTIONS` if values differ
- [ ] Ensure backend accepts `outreachStatus`, `clientInterest`, `associateToDeal` in POST payload
- [ ] Implement Deal↔Company association logic in backend (if not already present)
- [ ] Add `createdAt` timestamp to referral responses
- [ ] Replace `ReferralBuilderCard.tsx` with `ReferralBuilderCard_IMPROVED.tsx`
- [ ] Run `hs project upload` to deploy to HubSpot
- [ ] Test on Deal 53695922718 (no company scenario)
- [ ] Test on a deal with an existing company
- [ ] Verify all 6 test cases pass

---

## 🎯 SUMMARY OF CHANGES

| Issue | Root Cause | Fix | File Location |
|-------|-----------|-----|---------------|
| 400 Error | Missing `outreachStatus`, `clientInterest` in payload | Add default values and include in POST | Lines 330-341 |
| No company pre-selection | Never fetched deal associations | Added `loadDealCompanies()` function | Lines 151-186 |
| Company not associated to deal | No association creation logic | Added checkbox + `associateToDeal` flag | Lines 75-76, 459-466 |
| Generic error messages | Poor error parsing | Enhanced error extraction from API responses | Lines 103-136 |
| Poor UX | Single-column layout | Two-column responsive layout | Lines 405-598 |
| No loading states | Missing UI feedback | Added spinners, disabled states, "Creating..." text | Throughout |
| Property value mismatch | Using labels as values | Use internal values (e.g., `ready_to_send`) | Lines 38-56 |
| Double submits | No in-flight protection | Disabled button during `busy` state | Line 78, 491 |

---

## 🚀 NEXT STEPS

1. **Review HubSpot Property Internal Values**
   - Go to HubSpot → Settings → Objects → Referral
   - Check `referral_status` and `client_interest` property options
   - Verify internal values match the defaults in code (lines 38-56)

2. **Update Backend** (if needed)
   - Add support for `outreachStatus`, `clientInterest` fields
   - Implement `associateToDeal` logic
   - Return `createdAt` timestamps

3. **Deploy Frontend**
   ```bash
   cd /home/user/ref_build_jan12/referral-builder/hubspot-card
   cp src/app/cards/ReferralBuilderCard_IMPROVED.tsx src/app/cards/ReferralBuilderCard.tsx
   hs project upload
   ```

4. **Run Test Plan**
   - Execute all 6 test cases
   - Verify on Deal 53695922718

5. **Monitor Errors**
   - Check Vercel logs for backend errors
   - Check browser console for frontend errors
   - Iterate on any issues

---

## 📞 SUPPORT

If you encounter issues:
1. Check Vercel logs: `https://vercel.com/[your-project]/logs`
2. Check browser console for frontend errors
3. Verify API responses using Network tab in DevTools
4. Confirm HubSpot property internal values match code defaults
