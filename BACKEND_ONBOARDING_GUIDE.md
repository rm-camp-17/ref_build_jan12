# Backend Onboarding Guide - New Hire Walkthrough

## 🚨 THE PROBLEM (Plain English)

**Why Vercel deployment is failing:**

Your repository has a `referral-builder/vercel-api/` folder, but it's **completely empty** except for:
- `next.config.js` (a config file)
- `node_modules/` (probably from a failed install)

**What's missing:**
- ❌ NO `package.json` file (this is why `npm install` fails with "ENOENT: no such file or directory")
- ❌ NO `src/` folder with API routes
- ❌ NO dependencies installed
- ❌ NO lib files (hubspot.ts, config.ts, etc.)

**The error explained:**
When Vercel tries to build your project, it runs `npm install` to install dependencies. But without a `package.json` file, npm doesn't know what to install or even that this is a valid Node.js project. That's why you get the error: `ENOENT: no such file or directory, open '/vercel/path0/package.json'`.

**Bottom line:** The `vercel-api` backend needs to be built from scratch. The docs reference files that don't exist yet.

---

## 📁 CORRECT PROJECT STRUCTURE

Your **Vercel Project Root Directory** should be: `referral-builder/vercel-api`

After we're done, your structure will look like:

```
referral-builder/
├── hubspot-card/           # ✅ Frontend (HubSpot UI) - ALREADY EXISTS
│   ├── src/app/cards/ReferralBuilderCard.tsx
│   └── ... (already working)
│
└── vercel-api/             # ❌ Backend (API) - NEEDS TO BE CREATED
    ├── package.json        # ← CREATE THIS
    ├── tsconfig.json       # ← CREATE THIS
    ├── next.config.js      # ← ALREADY EXISTS
    ├── .env.example        # ← CREATE THIS
    ├── .gitignore          # ← CREATE THIS
    └── src/                # ← CREATE THIS
        ├── lib/
        │   ├── hubspot.ts
        │   ├── config.ts
        │   ├── associations.ts
        │   └── objects.ts
        └── app/
            └── api/
                ├── health/route.ts
                ├── companies/search/route.ts
                ├── companies/[companyId]/programs/route.ts
                ├── programs/[programId]/sessions/route.ts
                ├── deals/[dealId]/referrals/route.ts
                ├── referrals/route.ts
                ├── referrals/properties/route.ts
                └── referrals/[referralId]/route.ts
```

---

## ✅ STEP-BY-STEP FIX (New Hire Checklist)

### PART 1: Create Missing Backend Files

#### Step 1: Create `package.json`

**What you're doing:** Creating the project definition file that tells npm what dependencies to install.

**Command:**
```bash
cd /home/user/ref_build_jan12/referral-builder/vercel-api
```

**Create file:** `package.json`

**Paste this exact content:**
```json
{
  "name": "camp-referral-builder-api",
  "version": "1.0.0",
  "description": "Vercel API backend for Camp Referral Builder",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "@hubspot/api-client": "^11.2.0",
    "next": "^14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.5",
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "typescript": "^5.3.3"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Success check:** File created at `referral-builder/vercel-api/package.json`

---

#### Step 2: Create `tsconfig.json`

**What you're doing:** Configuring TypeScript compilation settings for Next.js.

**Create file:** `tsconfig.json`

**Paste this exact content:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Success check:** File created at `referral-builder/vercel-api/tsconfig.json`

---

#### Step 3: Create `.env.example`

**What you're doing:** Creating a template for environment variables (secrets).

**Create file:** `.env.example`

**Paste this exact content:**
```env
# HubSpot Private App Access Token
# Get this from: HubSpot Settings → Integrations → Private Apps
HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Custom Object Type IDs
# These are the internal names for your custom objects in HubSpot
# Usually in format: p_{object_name}
HS_PROGRAM_OBJECT_TYPE=p_program
HS_SESSION_OBJECT_TYPE=p_session
HS_REFERRAL_OBJECT_TYPE=p_referral

# Referral Object Property Names (2025.02 Schema)
# Editable properties
HS_REFERRAL_KEY_PROP=referral_key
HS_REFERRAL_OUTREACH_PROP=referral_status
HS_REFERRAL_INTEREST_PROP=client_interest
HS_REFERRAL_NOTE_PROP=referral_note_to_company
HS_REFERRAL_PREVIOUSLY_SENT_PROP=previously_sent_to_camp

# Auto-managed properties
HS_REFERRAL_NAME_PROP=referral_name
HS_REFERRAL_COPIED_DEAL_KEY_PROP=copied_from_deal_key
HS_REFERRAL_COPIED_YEAR_PROP=copied_from_year

# Optional: Deal properties for metadata copying
# HS_DEAL_KEY_PROP=deal_key_property_name
# HS_DEAL_YEAR_PROP=deal_year_property_name
```

**Success check:** File created at `referral-builder/vercel-api/.env.example`

---

#### Step 4: Create `.gitignore`

**What you're doing:** Telling git which files NOT to commit (secrets, dependencies, etc.).

**Create file:** `.gitignore`

**Paste this exact content:**
```
# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/

# Next.js
.next/
out/
build/

# Production
dist/

# Misc
.DS_Store
*.pem

# Debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Local env files
.env
.env*.local

# Vercel
.vercel

# TypeScript
*.tsbuildinfo
next-env.d.ts
```

**Success check:** File created at `referral-builder/vercel-api/.gitignore`

---

#### Step 5: Create Directory Structure

**What you're doing:** Creating the folder structure for your API routes and helper libraries.

**Commands:**
```bash
mkdir -p src/lib
mkdir -p src/app/api/health
mkdir -p src/app/api/companies/search
mkdir -p src/app/api/companies/[companyId]/programs
mkdir -p src/app/api/programs/[programId]/sessions
mkdir -p src/app/api/deals/[dealId]/referrals
mkdir -p src/app/api/referrals/properties
mkdir -p src/app/api/referrals/[referralId]
```

**Success check:** Run `ls -la src/` and verify folders exist

---

### PART 2: Create Library Files

#### Step 6: Create `src/lib/config.ts`

**What you're doing:** Centralizing environment variable access.

**Create file:** `src/lib/config.ts`

**Paste this exact content:**
```typescript
// Environment configuration for HubSpot integration
export const config = {
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
  },
  objectTypes: {
    program: process.env.HS_PROGRAM_OBJECT_TYPE || 'p_program',
    session: process.env.HS_SESSION_OBJECT_TYPE || 'p_session',
    referral: process.env.HS_REFERRAL_OBJECT_TYPE || 'p_referral',
  },
  properties: {
    referral: {
      key: process.env.HS_REFERRAL_KEY_PROP || 'referral_key',
      outreach: process.env.HS_REFERRAL_OUTREACH_PROP || 'referral_status',
      interest: process.env.HS_REFERRAL_INTEREST_PROP || 'client_interest',
      note: process.env.HS_REFERRAL_NOTE_PROP || 'referral_note_to_company',
      previouslySent: process.env.HS_REFERRAL_PREVIOUSLY_SENT_PROP || 'previously_sent_to_camp',
      name: process.env.HS_REFERRAL_NAME_PROP || 'referral_name',
      copiedDealKey: process.env.HS_REFERRAL_COPIED_DEAL_KEY_PROP || 'copied_from_deal_key',
      copiedYear: process.env.HS_REFERRAL_COPIED_YEAR_PROP || 'copied_from_year',
    },
    deal: {
      key: process.env.HS_DEAL_KEY_PROP || 'deal_key',
      year: process.env.HS_DEAL_YEAR_PROP || 'deal_year',
    },
  },
};
```

**Success check:** File created at `src/lib/config.ts`

---

#### Step 7: Create `src/lib/hubspot.ts`

**What you're doing:** Initializing the HubSpot API client.

**Create file:** `src/lib/hubspot.ts`

**Paste this exact content:**
```typescript
import { Client } from '@hubspot/api-client';
import { config } from './config';

if (!config.hubspot.accessToken) {
  throw new Error(
    'HUBSPOT_ACCESS_TOKEN is not defined. Please set it in your environment variables.'
  );
}

export const hubspotClient = new Client({
  accessToken: config.hubspot.accessToken,
});
```

**Success check:** File created at `src/lib/hubspot.ts`

---

#### Step 8: Create `src/lib/associations.ts`

**What you're doing:** Helper functions for creating HubSpot associations between objects.

**Create file:** `src/lib/associations.ts`

**Paste this exact content:**
```typescript
import { hubspotClient } from './hubspot';

// Cache for association type IDs to avoid repeated API calls
const associationTypeCache: Record<string, number> = {};

/**
 * Fetch association type ID between two object types
 * Example: getAssociationTypeId('deals', 'companies') → 3
 */
export async function getAssociationTypeId(
  fromObjectType: string,
  toObjectType: string,
  label?: string
): Promise<number> {
  const cacheKey = `${fromObjectType}-${toObjectType}`;

  // Return cached value if exists
  if (associationTypeCache[cacheKey]) {
    return associationTypeCache[cacheKey];
  }

  try {
    // Fetch association schema
    const types = await hubspotClient.crm.associations.schemaApi.getAll(
      fromObjectType,
      toObjectType
    );

    // Find matching type by label (or use first if no label provided)
    const matchingType = label
      ? types.results.find((t) => t.label === label)
      : types.results[0];

    if (!matchingType) {
      throw new Error(
        `No association type found for ${fromObjectType} → ${toObjectType}`
      );
    }

    // Cache and return
    associationTypeCache[cacheKey] = matchingType.typeId;
    return matchingType.typeId;
  } catch (error) {
    console.error(`Failed to fetch association type ID:`, error);
    throw error;
  }
}

/**
 * Create an association between two objects
 * Example: createAssociation('12345', 'referral', '67890', 'deals')
 */
export async function createAssociation(
  fromObjectId: string,
  fromObjectType: string,
  toObjectId: string,
  toObjectType: string
): Promise<void> {
  try {
    const associationTypeId = await getAssociationTypeId(
      fromObjectType,
      toObjectType
    );

    await hubspotClient.crm.associations.batchApi.create({
      inputs: [
        {
          from: { id: fromObjectId },
          to: { id: toObjectId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId,
            },
          ],
        },
      ],
    });

    console.log(
      `✓ Created association: ${fromObjectType}:${fromObjectId} → ${toObjectType}:${toObjectId}`
    );
  } catch (error: any) {
    console.error(`Failed to create association:`, error);
    throw new Error(
      `Association failed: ${fromObjectType} → ${toObjectType}: ${error.message}`
    );
  }
}
```

**Success check:** File created at `src/lib/associations.ts`

---

#### Step 9: Create `src/lib/objects.ts`

**What you're doing:** Helper functions for fetching HubSpot object data.

**Create file:** `src/lib/objects.ts`

**Paste this exact content:**
```typescript
import { hubspotClient } from './hubspot';

/**
 * Fetch a single HubSpot object by ID with specified properties
 */
export async function getObject(
  objectType: string,
  objectId: string,
  properties: string[]
): Promise<any> {
  try {
    const result = await hubspotClient.crm.objects.basicApi.getById(
      objectType,
      objectId,
      properties
    );
    return result;
  } catch (error: any) {
    console.error(`Failed to fetch ${objectType}:${objectId}:`, error);
    throw new Error(`Failed to fetch ${objectType}: ${error.message}`);
  }
}

/**
 * Fetch associated objects
 * Example: getAssociatedObjects('deals', '12345', 'companies')
 */
export async function getAssociatedObjects(
  fromObjectType: string,
  fromObjectId: string,
  toObjectType: string
): Promise<any[]> {
  try {
    const result = await hubspotClient.crm.associations.batchApi.read({
      inputs: [
        {
          id: fromObjectId,
        },
      ],
      fromObjectType,
      toObjectType,
    });

    if (result.results.length === 0 || !result.results[0].to) {
      return [];
    }

    return result.results[0].to.map((assoc: any) => assoc.toObjectId);
  } catch (error: any) {
    console.error(
      `Failed to fetch associated ${toObjectType} for ${fromObjectType}:${fromObjectId}:`,
      error
    );
    return [];
  }
}
```

**Success check:** File created at `src/lib/objects.ts`

---

### PART 3: Create API Routes

#### Step 10: Create Health Check Endpoint

**What you're doing:** Creating a simple endpoint to verify the API is running.

**Create file:** `src/app/api/health/route.ts`

**Paste this exact content:**
```typescript
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
  });
}
```

**Success check:** File created at `src/app/api/health/route.ts`

---

#### Step 11: Create Company Search Endpoint

**Create file:** `src/app/api/companies/search/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q') || '';
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  if (!query) {
    return NextResponse.json(
      { error: 'Query parameter "q" is required' },
      { status: 400 }
    );
  }

  try {
    const searchResults = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'name',
              operator: 'CONTAINS_TOKEN',
              value: query,
            },
          ],
        },
      ],
      properties: ['name'],
      limit,
      sorts: [{ propertyName: 'name', direction: 'ASCENDING' }],
    });

    const results = searchResults.results.map((company) => ({
      id: company.id,
      name: company.properties.name || 'Unnamed Company',
    }));

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('Company search failed:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to search companies' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/companies/search/route.ts`

---

#### Step 12: Create Get Programs Endpoint

**Create file:** `src/app/api/companies/[companyId]/programs/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { companyId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { companyId } = params;

  if (!companyId) {
    return NextResponse.json(
      { error: 'Company ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch programs associated with this company
    const associationsResult = await hubspotClient.crm.associations.batchApi.read({
      inputs: [{ id: companyId }],
      fromObjectType: 'companies',
      toObjectType: config.objectTypes.program,
    });

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const programIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch program details
    const programs = await Promise.all(
      programIds.map(async (programId: string) => {
        const program = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.program,
          programId,
          ['name']
        );
        return {
          id: program.id,
          name: program.properties.name || 'Unnamed Program',
        };
      })
    );

    return NextResponse.json({ results: programs });
  } catch (error: any) {
    console.error('Failed to fetch programs:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch programs' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/companies/[companyId]/programs/route.ts`

---

#### Step 13: Create Get Sessions Endpoint

**Create file:** `src/app/api/programs/[programId]/sessions/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { programId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { programId } = params;

  if (!programId) {
    return NextResponse.json(
      { error: 'Program ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch sessions associated with this program
    const associationsResult = await hubspotClient.crm.associations.batchApi.read({
      inputs: [{ id: programId }],
      fromObjectType: config.objectTypes.program,
      toObjectType: config.objectTypes.session,
    });

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const sessionIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch session details
    const sessions = await Promise.all(
      sessionIds.map(async (sessionId: string) => {
        const session = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.session,
          sessionId,
          ['name', 'start_date', 'end_date', 'price', 'weeks']
        );
        return {
          id: session.id,
          name: session.properties.name || 'Unnamed Session',
          startDate: session.properties.start_date || null,
          endDate: session.properties.end_date || null,
          price: session.properties.price || null,
          weeks: session.properties.weeks || null,
        };
      })
    );

    return NextResponse.json({ results: sessions });
  } catch (error: any) {
    console.error('Failed to fetch sessions:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/programs/[programId]/sessions/route.ts`

---

#### Step 14: Create Get Referrals for Deal Endpoint

**Create file:** `src/app/api/deals/[dealId]/referrals/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { dealId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { dealId } = params;

  if (!dealId) {
    return NextResponse.json(
      { error: 'Deal ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch referrals associated with this deal
    const associationsResult = await hubspotClient.crm.associations.batchApi.read({
      inputs: [{ id: dealId }],
      fromObjectType: 'deals',
      toObjectType: config.objectTypes.referral,
    });

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const referralIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch referral details with associations
    const referrals = await Promise.all(
      referralIds.map(async (referralId: string) => {
        const referral = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.referral,
          referralId,
          [
            config.properties.referral.key,
            config.properties.referral.outreach,
            config.properties.referral.interest,
            config.properties.referral.note,
            'hs_createdate', // ✅ CRITICAL: Include created timestamp
          ],
          undefined,
          ['companies', config.objectTypes.program, config.objectTypes.session],
          false
        );

        // Extract associated objects
        const company = referral.associations?.companies?.[0];
        const program = referral.associations?.[config.objectTypes.program]?.[0];
        const session = referral.associations?.[config.objectTypes.session]?.[0];

        // Fetch details for associated objects
        let companyData = null;
        let programData = null;
        let sessionData = null;

        if (company?.id) {
          const companyObj = await hubspotClient.crm.companies.basicApi.getById(
            company.id,
            ['name']
          );
          companyData = {
            id: companyObj.id,
            name: companyObj.properties.name || 'Unnamed Company',
          };
        }

        if (program?.id) {
          const programObj = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.program,
            program.id,
            ['name']
          );
          programData = {
            id: programObj.id,
            name: programObj.properties.name || 'Unnamed Program',
          };
        }

        if (session?.id) {
          const sessionObj = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.session,
            session.id,
            ['name', 'start_date', 'end_date', 'price', 'weeks']
          );
          sessionData = {
            id: sessionObj.id,
            name: sessionObj.properties.name || 'Unnamed Session',
            startDate: sessionObj.properties.start_date || null,
            endDate: sessionObj.properties.end_date || null,
            price: sessionObj.properties.price || null,
            weeks: sessionObj.properties.weeks || null,
          };
        }

        return {
          id: referral.id,
          referralKey: referral.properties[config.properties.referral.key],
          outreachStatus: referral.properties[config.properties.referral.outreach],
          clientInterest: referral.properties[config.properties.referral.interest],
          note: referral.properties[config.properties.referral.note] || '',
          createdAt: referral.properties.hs_createdate, // ✅ RETURN TIMESTAMP
          company: companyData,
          program: programData,
          session: sessionData,
        };
      })
    );

    return NextResponse.json({ results: referrals });
  } catch (error: any) {
    console.error('Failed to fetch referrals:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch referrals' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/deals/[dealId]/referrals/route.ts`

---

#### Step 15: Create POST Referral Endpoint (MOST IMPORTANT)

**Create file:** `src/app/api/referrals/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { createAssociation, getAssociationTypeId } from '@/lib/associations';

export async function POST(req: NextRequest) {
  const body = await req.json();

  const {
    dealId,
    companyId,
    programId,
    sessionId,
    note,
    outreachStatus,     // ✅ REQUIRED - internal value
    clientInterest,     // ✅ REQUIRED - internal value
    associateToDeal,    // ✅ NEW FLAG - create Deal↔Company association
  } = body;

  // Validation
  if (!dealId || !companyId) {
    return NextResponse.json(
      { error: 'dealId and companyId are required' },
      { status: 400 }
    );
  }

  if (!outreachStatus || !clientInterest) {
    return NextResponse.json(
      { error: 'outreachStatus and clientInterest are required' },
      { status: 400 }
    );
  }

  // Build referral properties
  const referralKey = `${dealId}-${companyId}`;
  const properties: Record<string, any> = {
    [config.properties.referral.key]: referralKey,
    [config.properties.referral.outreach]: outreachStatus,   // Use internal value
    [config.properties.referral.interest]: clientInterest,   // Use internal value
    [config.properties.referral.note]: note || '',
    [config.properties.referral.name]: `Referral for Deal ${dealId}`,
  };

  let referralId: string;
  let created = false;

  try {
    // Step 1: Search for existing referral by key (upsert logic)
    const searchResults = await hubspotClient.crm.objects.searchApi.doSearch(
      config.objectTypes.referral,
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: config.properties.referral.key,
                operator: 'EQ',
                value: referralKey,
              },
            ],
          },
        ],
        limit: 1,
      }
    );

    if (searchResults.results.length > 0) {
      // Update existing referral
      referralId = searchResults.results[0].id;
      await hubspotClient.crm.objects.basicApi.update(
        config.objectTypes.referral,
        referralId,
        { properties }
      );
      created = false;
      console.log(`✓ Updated referral: ${referralId}`);
    } else {
      // Create new referral
      const createResult = await hubspotClient.crm.objects.basicApi.create(
        config.objectTypes.referral,
        { properties }
      );
      referralId = createResult.id;
      created = true;
      console.log(`✓ Created referral: ${referralId}`);
    }
  } catch (error: any) {
    console.error('Failed to create/update referral:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create referral' },
      { status: 500 }
    );
  }

  // Step 2: Create associations to Deal, Company, Program, Session
  try {
    const associationsToCreate: Array<{
      toType: string;
      toId: string;
    }> = [
      { toType: 'deals', toId: dealId },
      { toType: 'companies', toId: companyId },
    ];

    if (programId) {
      associationsToCreate.push({
        toType: config.objectTypes.program,
        toId: programId,
      });
    }

    if (sessionId) {
      associationsToCreate.push({
        toType: config.objectTypes.session,
        toId: sessionId,
      });
    }

    for (const assoc of associationsToCreate) {
      await createAssociation(
        referralId,
        config.objectTypes.referral,
        assoc.toId,
        assoc.toType
      );
    }
  } catch (error: any) {
    console.error('Failed to create associations:', error);
    // Don't fail the entire request if associations fail
  }

  // Step 3: ✅ NEW - Create Deal↔Company association if requested
  if (associateToDeal === true) {
    try {
      const dealToCompanyTypeId = await getAssociationTypeId(
        'deals',
        'companies'
      );

      await hubspotClient.crm.associations.batchApi.create({
        inputs: [
          {
            from: { id: dealId },
            to: { id: companyId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: dealToCompanyTypeId,
              },
            ],
          },
        ],
      });
      console.log(`✓ Created Deal↔Company association: ${dealId} ↔ ${companyId}`);
    } catch (error: any) {
      console.error('Failed to create Deal↔Company association:', error);
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

**Success check:** File created at `src/app/api/referrals/route.ts`

---

#### Step 16: Create Update Referral Endpoint

**Create file:** `src/app/api/referrals/[referralId]/route.ts`

**Paste this exact content:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { referralId: string };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { referralId } = params;
  const body = await req.json();

  if (!referralId) {
    return NextResponse.json(
      { error: 'Referral ID is required' },
      { status: 400 }
    );
  }

  if (!body.properties || typeof body.properties !== 'object') {
    return NextResponse.json(
      { error: 'properties object is required' },
      { status: 400 }
    );
  }

  try {
    await hubspotClient.crm.objects.basicApi.update(
      config.objectTypes.referral,
      referralId,
      { properties: body.properties }
    );

    console.log(`✓ Updated referral ${referralId}:`, body.properties);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Failed to update referral:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update referral' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/referrals/[referralId]/route.ts`

---

#### Step 17: Create Get Properties Endpoint

**What you're doing:** Creating an endpoint to verify HubSpot property internal values.

**Create file:** `src/app/api/referrals/properties/route.ts`

**Paste this exact content:**
```typescript
import { NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

export async function GET() {
  try {
    // Fetch property definitions for referral enums
    const [statusProp, interestProp] = await Promise.all([
      hubspotClient.crm.properties.coreApi.getByName(
        config.objectTypes.referral,
        config.properties.referral.outreach
      ),
      hubspotClient.crm.properties.coreApi.getByName(
        config.objectTypes.referral,
        config.properties.referral.interest
      ),
    ]);

    // Extract options with INTERNAL values
    const properties = {
      [config.properties.referral.outreach]: {
        name: statusProp.name,
        label: statusProp.label,
        options:
          statusProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // ✅ This is the internal value
          })) || [],
      },
      [config.properties.referral.interest]: {
        name: interestProp.name,
        label: interestProp.label,
        options:
          interestProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // ✅ This is the internal value
          })) || [],
      },
    };

    return NextResponse.json({ properties });
  } catch (error: any) {
    console.error('Failed to load properties:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load properties' },
      { status: 500 }
    );
  }
}
```

**Success check:** File created at `src/app/api/referrals/properties/route.ts`

---

### PART 4: Install Dependencies

#### Step 18: Install Dependencies

**What you're doing:** Installing all required npm packages.

**Command:**
```bash
cd /home/user/ref_build_jan12/referral-builder/vercel-api
npm install
```

**Expected output:**
```
added 250+ packages in 15s
```

**Success check:** Run `ls node_modules/ | wc -l` → Should show 250+

---

### PART 5: Local Testing (CRITICAL)

#### Step 19: Create Local `.env` File

**What you're doing:** Creating environment variables for local development.

**Command:**
```bash
cp .env.example .env
```

**Edit the `.env` file and add your REAL HubSpot access token:**
```bash
# Use nano or your preferred editor
nano .env
```

**Paste your token:**
```env
HUBSPOT_ACCESS_TOKEN=pat-na1-YOUR-REAL-TOKEN-HERE
HS_PROGRAM_OBJECT_TYPE=p_program
HS_SESSION_OBJECT_TYPE=p_session
HS_REFERRAL_OBJECT_TYPE=p_referral
# ... rest of the values from .env.example
```

**Success check:** Run `cat .env | grep HUBSPOT_ACCESS_TOKEN` → Should show your token

---

#### Step 20: Start Local Development Server

**What you're doing:** Running the API locally to test before deploying.

**Command:**
```bash
npm run dev
```

**Expected output:**
```
> camp-referral-builder-api@1.0.0 dev
> next dev

   ▲ Next.js 14.1.0
   - Local:        http://localhost:3000
   - Network:      http://0.0.0.0:3000

 ✓ Ready in 2.5s
```

**Success check:** Server starts without errors

---

#### Step 21: Test Health Endpoint

**What you're doing:** Verifying the API is responding.

**Open a NEW terminal tab and run:**
```bash
curl http://localhost:3000/api/health
```

**Expected output:**
```json
{"ok":true,"ts":"2026-01-13T..."}
```

**Success check:** You get `{"ok":true,...}`

---

#### Step 22: Test Company Search

**What you're doing:** Verifying HubSpot API connection works.

**Command:**
```bash
curl "http://localhost:3000/api/companies/search?q=camp"
```

**Expected output:**
```json
{"results":[{"id":"12345","name":"Camp Adventure"},...]}
```

**Success check:** You get a list of companies (or empty array if no matches)

**If you get an error:** Check that your `HUBSPOT_ACCESS_TOKEN` in `.env` is correct

---

#### Step 23: Test Property Values Endpoint

**What you're doing:** Checking if HubSpot property internal values match frontend.

**Command:**
```bash
curl http://localhost:3000/api/referrals/properties
```

**Expected output:**
```json
{
  "properties": {
    "referral_status": {
      "options": [
        {"label":"Draft","value":"draft"},
        {"label":"Ready to Send","value":"ready_to_send"},
        ...
      ]
    },
    "client_interest": {
      "options": [
        {"label":"Active / considering","value":"active_considering"},
        ...
      ]
    }
  }
}
```

**Success check:** You get property options with `value` fields

**⚠️ CRITICAL:** Check if the `value` fields match the frontend defaults:
- Frontend uses: `draft`, `ready_to_send`, `sent`, `resend`, `dont_send`
- Frontend uses: `active_considering`, `shortlist`, `neutral`, `unlikely`, `declined`, `selected`

**If values DON'T match:** You'll need to update the frontend component later (we'll cover this)

---

#### Step 24: Stop Local Server

**What you're doing:** Stopping the dev server before deploying.

**Press:** `Ctrl+C` in the terminal where `npm run dev` is running

**Success check:** Server stops

---

### PART 6: Deploy to Vercel

#### Step 25: Install Vercel CLI (if not installed)

**Command:**
```bash
npm install -g vercel
```

**Success check:** Run `vercel --version` → Should show version number

---

#### Step 26: Deploy to Vercel

**What you're doing:** Deploying your backend to Vercel's production servers.

**Command:**
```bash
cd /home/user/ref_build_jan12/referral-builder/vercel-api
vercel
```

**Follow the prompts:**
```
? Set up and deploy "~/referral-builder/vercel-api"? [Y/n] Y
? Which scope do you want to deploy to? [Your Vercel Account]
? Link to existing project? [y/N] N
? What's your project's name? camp-referral-builder-api
? In which directory is your code located? ./
```

**Vercel will auto-detect:**
```
Auto-detected Project Settings (Next.js):
- Build Command: next build
- Development Command: next dev --port $PORT
- Install Command: npm install
- Output Directory: Next.js default
```

**Accept and deploy:**
```
? Want to modify these settings? [y/N] N
```

**Expected output:**
```
🔗  Linked to your-account/camp-referral-builder-api
🔍  Inspect: https://vercel.com/...
✅  Production: https://camp-referral-builder-api-xyz123.vercel.app [3s]
```

**Success check:** You get a production URL like `https://camp-referral-builder-api-xyz123.vercel.app`

**📝 SAVE THIS URL!** You'll need it in the next steps.

---

#### Step 27: Add Environment Variables in Vercel

**What you're doing:** Adding your HubSpot credentials to Vercel.

**Go to:** Vercel Dashboard → Your Project → Settings → Environment Variables

**Add these variables:**

| Key | Value | Environment |
|-----|-------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | `pat-na1-your-token-here` | Production, Preview, Development |
| `HS_PROGRAM_OBJECT_TYPE` | `p_program` | Production, Preview, Development |
| `HS_SESSION_OBJECT_TYPE` | `p_session` | Production, Preview, Development |
| `HS_REFERRAL_OBJECT_TYPE` | `p_referral` | Production, Preview, Development |
| `HS_REFERRAL_KEY_PROP` | `referral_key` | Production, Preview, Development |
| `HS_REFERRAL_OUTREACH_PROP` | `referral_status` | Production, Preview, Development |
| `HS_REFERRAL_INTEREST_PROP` | `client_interest` | Production, Preview, Development |
| `HS_REFERRAL_NOTE_PROP` | `referral_note_to_company` | Production, Preview, Development |
| `HS_REFERRAL_NAME_PROP` | `referral_name` | Production, Preview, Development |

**Success check:** All variables added

---

#### Step 28: Redeploy After Adding Env Vars

**What you're doing:** Redeploying so environment variables take effect.

**Command:**
```bash
vercel --prod
```

**Success check:** Deployment completes successfully

---

#### Step 29: Test Production Endpoint

**What you're doing:** Verifying the production API works.

**Replace `YOUR-VERCEL-URL` with your actual URL:**
```bash
curl https://YOUR-VERCEL-URL.vercel.app/api/health
```

**Expected output:**
```json
{"ok":true,"ts":"2026-01-13T..."}
```

**Success check:** Health check returns OK

---

### PART 7: Configure Vercel Project Settings

#### Step 30: Set Root Directory (CRITICAL)

**What you're doing:** Telling Vercel which folder contains your backend code.

**Go to:** Vercel Dashboard → Your Project → Settings → General

**Scroll to "Build & Development Settings"**

**Set these values:**

| Setting | Value |
|---------|-------|
| Root Directory | `referral-builder/vercel-api` |
| Build Command | `next build` (auto-detected) |
| Install Command | `npm install` (auto-detected) |
| Output Directory | (leave empty - Next.js default) |

**Success check:** Settings saved

**Redeploy after changing root directory:**
```bash
vercel --prod
```

---

## 🎯 FINAL VERIFICATION CHECKLIST

Run these commands to verify everything is set up correctly:

### File Structure Check
```bash
cd /home/user/ref_build_jan12/referral-builder/vercel-api
ls -la package.json tsconfig.json .env.example .gitignore next.config.js
ls -la src/lib/
ls -la src/app/api/health/
ls -la src/app/api/referrals/
```

**Expected:** All files exist ✅

### Dependency Check
```bash
npm list @hubspot/api-client next typescript
```

**Expected:** All packages installed ✅

### Local Server Check
```bash
npm run dev &
sleep 5
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/companies/search?q=test"
kill %1
```

**Expected:** Both endpoints return JSON ✅

### Production Check
```bash
curl https://YOUR-VERCEL-URL.vercel.app/api/health
```

**Expected:** Returns `{"ok":true,...}` ✅

---

## 🚀 NEXT STEPS

### Update Frontend to Use New Backend

The frontend (HubSpot card) needs to be updated to point to your Vercel URL.

**Edit these 2 files:**

#### 1. `referral-builder/hubspot-card/src/app/app-hsmeta.json`
```json
{
  "permittedUrls": {
    "fetch": [
      "https://api.hubapi.com",
      "https://YOUR-VERCEL-URL.vercel.app"
    ]
  }
}
```

#### 2. `referral-builder/hubspot-card/src/app/cards/ReferralBuilderCard.tsx`
Find line ~13:
```typescript
const API_BASE = "https://YOUR-VERCEL-URL.vercel.app";
```

---

## 🐛 TROUBLESHOOTING

### Error: "HUBSPOT_ACCESS_TOKEN is not defined"
- **Cause:** Environment variable not set
- **Fix:** Add `HUBSPOT_ACCESS_TOKEN` in Vercel Dashboard → Settings → Environment Variables
- **Then:** Redeploy with `vercel --prod`

### Error: "Failed to search companies"
- **Cause:** Invalid HubSpot token or missing scopes
- **Fix:** Generate new private app token with these scopes:
  - `crm.objects.deals.read`
  - `crm.objects.deals.write`
  - `crm.objects.companies.read`
  - `crm.objects.custom.read`
  - `crm.objects.custom.write`

### Error: "No association type found"
- **Cause:** Custom objects not properly associated in HubSpot
- **Fix:** Go to HubSpot Settings → Objects → Referral → Associations
- **Verify:** Referral is associated with Deal, Company, Program, Session

### Vercel Build Fails: "Cannot find module '@/lib/hubspot'"
- **Cause:** TypeScript path alias not configured
- **Fix:** Verify `tsconfig.json` has:
  ```json
  "paths": {
    "@/*": ["./src/*"]
  }
  ```

### Local Dev Works, Production Doesn't
- **Cause:** Environment variables not set in Vercel
- **Fix:** Double-check all env vars in Vercel Dashboard
- **Then:** Redeploy

---

## 📚 HOW TO VERIFY HUBSPOT INTERNAL VALUES

The frontend uses dropdown internal values like `draft`, `ready_to_send`, etc.

**To verify these match HubSpot:**

### Option 1: Via API (Recommended)
```bash
curl https://YOUR-VERCEL-URL.vercel.app/api/referrals/properties
```

Check the `value` fields in the response.

### Option 2: Via HubSpot UI
1. Go to: HubSpot Settings → Objects → Referral → Properties
2. Find "Referral Status" property
3. Click "Edit"
4. Check the "Internal value" column (NOT the label)

**If values don't match:**
- Update the frontend defaults in `ReferralBuilderCard.tsx` (lines 38-56)
- Or update HubSpot property internal values to match frontend

---

## 🎉 YOU'RE DONE!

Your backend is now:
- ✅ Fully scaffolded with all required files
- ✅ Deployable to Vercel
- ✅ Connected to HubSpot API
- ✅ Ready for the frontend to use

**Next:** Deploy the HubSpot card with updated Vercel URL
**Then:** Test the full flow from a Deal record in HubSpot

---

## 📞 COMMON COMMANDS REFERENCE

```bash
# Local development
cd referral-builder/vercel-api
npm run dev

# Deploy to production
vercel --prod

# View logs
vercel logs

# Check environment variables
vercel env ls

# Test endpoints
curl https://YOUR-URL.vercel.app/api/health
curl "https://YOUR-URL.vercel.app/api/companies/search?q=test"
curl https://YOUR-URL.vercel.app/api/referrals/properties
```

---

**Built with ❤️ for Camp Referral Builder**
