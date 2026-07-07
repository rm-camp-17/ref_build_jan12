/**
 * Tests for the deal↔company guard: the §8 matching rule, the reconciler
 * (Safeguard B), and the pre-send gate (Safeguard A). Regression fixtures
 * mirror the wrong-camp incident (deal "SUMMER DISCOVERY" carrying the
 * child's 5-camp referral set, emailing ACA).
 */

const mockCompanyGetById = jest.fn();
const mockArchive = jest.fn();
const mockCreate = jest.fn();
jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      companies: { basicApi: { getById: (...a: any[]) => mockCompanyGetById(...a) } },
      associations: {
        v4: {
          basicApi: {
            archive: (...a: any[]) => mockArchive(...a),
            create: (...a: any[]) => mockCreate(...a),
          },
        },
      },
    },
  },
}));

const mockGetAssociatedIds = jest.fn();
jest.mock('../lib/associations', () => ({
  getAssociatedIds: (...a: any[]) => mockGetAssociatedIds(...a),
}));

import {
  normName,
  scoreCompanyMatch,
  pickCompanyForProgram,
  reconcileDealCompany,
  enrollmentSendGate,
} from '../lib/deal-company-guard';

// The Austin Gomez fixture: 5 referral camps on the deal, program = Summer Discovery.
const GOMEZ_COMPANIES: Record<string, string> = {
  '1': 'ACA (American Collegiate Adventures)',
  '2': 'WestCoast Connection',
  '3': 'NSLC',
  '4': 'SUMMER DISCOVERY',
  '5': 'Summer Springboard',
};

function wireCompanies(companies: Record<string, string>) {
  mockGetAssociatedIds.mockResolvedValue(Object.keys(companies));
  mockCompanyGetById.mockImplementation((id: string) =>
    Promise.resolve({ properties: { name: companies[id] } })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockArchive.mockResolvedValue({});
  mockCreate.mockResolvedValue({});
});

describe('matching rule (§8)', () => {
  test('normalize-equal scores 100 across case/punctuation', () => {
    expect(scoreCompanyMatch('SUMMER DISCOVERY', 'Summer Discovery')).toBe(100);
    expect(normName('BRITISH SUMMER SCHOOL-EXSPORTISE')).toBe(
      'britishsummerschoolexsportise'
    );
  });

  test('substring either way scores 90', () => {
    expect(scoreCompanyMatch('BIRCHMONT', 'CAMP BIRCHMONT')).toBe(90);
    expect(scoreCompanyMatch('CAMP JACK SUMMER', 'CAMP JACK')).toBe(90);
  });

  test('token overlap handles reordered variants', () => {
    const s = scoreCompanyMatch(
      'BRITISH SUMMER SCHOOL-EXSPORTISE',
      'EXSPORTISE-BRITISH SUMMER SCHOOL'
    );
    expect(s).toBeGreaterThanOrEqual(4); // all four tokens shared
  });

  test('picks the program company out of the referral set', () => {
    const companies = Object.entries(GOMEZ_COMPANIES).map(([id, name]) => ({ id, name }));
    const keep = pickCompanyForProgram('SUMMER DISCOVERY', companies);
    expect(keep?.id).toBe('4');
  });

  test('ambiguous tie is not a confident match', () => {
    const keep = pickCompanyForProgram('SUMMER CAMP', [
      { id: '1', name: 'Alpha Summer Program' }, // 1 shared token
      { id: '2', name: 'Beta Summer Program' }, // 1 shared token
    ]);
    expect(keep).toBeNull();
  });
});

describe('reconcileDealCompany (Safeguard B)', () => {
  test('multi-company deal reduces to the programname match (Gomez regression)', async () => {
    wireCompanies(GOMEZ_COMPANIES);
    const result = await reconcileDealCompany('61750196319', 'SUMMER DISCOVERY', {
      apply: true,
    });
    expect(result.status).toBe('fixed');
    expect(result.kept?.id).toBe('4');
    expect(result.removed.sort()).toEqual(['1', '2', '3', '5']);
    // Removed exactly the four non-matching camps.
    expect(mockArchive).toHaveBeenCalledTimes(4);
    // Kept company re-asserted with default (341) + Primary (5).
    expect(mockCreate).toHaveBeenCalledWith('deals', '61750196319', 'companies', '4', [
      { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 341 },
      { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 },
    ]);
  });

  test('apply=false reports would_fix without writing', async () => {
    wireCompanies(GOMEZ_COMPANIES);
    const result = await reconcileDealCompany('61750196319', 'SUMMER DISCOVERY', {
      apply: false,
    });
    expect(result.status).toBe('would_fix');
    expect(mockArchive).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('single matching company → ok, untouched', async () => {
    wireCompanies({ '4': 'Summer Discovery' });
    const result = await reconcileDealCompany('1', 'SUMMER DISCOVERY', { apply: true });
    expect(result.status).toBe('ok');
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('zero companies / no confident match are flagged, never guessed', async () => {
    wireCompanies({});
    expect(
      (await reconcileDealCompany('1', 'SUMMER DISCOVERY', { apply: true })).status
    ).toBe('zero_companies');

    wireCompanies({ '7': 'Deer Hill', '8': 'Wilderness Adventures' });
    const result = await reconcileDealCompany('1', 'ACADEMY CAMPS', { apply: true });
    expect(result.status).toBe('no_confident_match');
    expect(mockArchive).not.toHaveBeenCalled();
  });
});

describe('enrollmentSendGate (Safeguard A)', () => {
  test('exactly one matching company → allowed', async () => {
    wireCompanies({ '4': 'SUMMER DISCOVERY' });
    const gate = await enrollmentSendGate('1', 'Summer Discovery');
    expect(gate.allowed).toBe(true);
    expect(gate.autoFixed).toBe(false);
  });

  test('multi-company with a confident match → auto-fixed and allowed', async () => {
    wireCompanies(GOMEZ_COMPANIES);
    const gate = await enrollmentSendGate('61750196319', 'SUMMER DISCOVERY');
    expect(gate.allowed).toBe(true);
    expect(gate.autoFixed).toBe(true);
    expect(mockArchive).toHaveBeenCalledTimes(4);
  });

  test('zero companies → blocked (the "no company associated" failure mode)', async () => {
    wireCompanies({});
    const gate = await enrollmentSendGate('1', 'INDEPENDENT LAKE EURO-MEX');
    expect(gate.allowed).toBe(false);
    expect(gate.message).toMatch(/no recipient/i);
  });

  test('single NON-matching company → blocked, no guessing', async () => {
    wireCompanies({ '9': 'ACA (American Collegiate Adventures)' });
    const gate = await enrollmentSendGate('1', 'SUMMER DISCOVERY');
    expect(gate.allowed).toBe(false);
    expect(gate.status).toBe('single_mismatch');
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('blank programname → blocked', async () => {
    wireCompanies({ '4': 'SUMMER DISCOVERY' });
    const gate = await enrollmentSendGate('1', '');
    expect(gate.allowed).toBe(false);
    expect(gate.status).toBe('no_program');
  });
});
