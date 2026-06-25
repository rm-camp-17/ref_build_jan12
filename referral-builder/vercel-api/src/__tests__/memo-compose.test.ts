/**
 * Tests the memo composer's prompt assembly and response handling without
 * calling Claude (the SDK is mocked). Verifies the structured response is
 * normalized, and that refusals / malformed JSON / empty input are surfaced as
 * MemoComposeError.
 */

let mockFinal: any;

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class MockAnthropic {
    messages = {
      stream: (_params: any) => ({
        finalMessage: async () => mockFinal,
      }),
    };
    constructor(_opts: any) {}
  },
}));

jest.mock('../lib/config', () => ({
  config: {
    memo: {
      anthropicApiKey: 'test-key',
      model: 'claude-opus-4-8',
      filesFolderPath: 'f',
      writeupSource: 'seed',
    },
  },
}));

import {
  composeMemo,
  buildUserPrompt,
  MemoComposeError,
  type MemoCampInput,
  type MemoContext,
} from '../lib/memo-compose';

const camps: MemoCampInput[] = [
  {
    companyId: 'c1',
    name: 'Chestnut Lake',
    writeupText: 'A traditional Wayne County camp.',
    writeupType: 'writeup',
    sessions: [
      {
        name: '3-week',
        weeks: 3,
        tuition: 9000,
        currency: 'USD',
        startDate: 'Jun 28',
        endDate: 'Jul 19',
        ageMin: 7,
        ageMax: 15,
        notes: '',
      },
    ],
  },
  {
    companyId: 'c2',
    name: 'Timber Lake West',
    writeupText: null,
    writeupType: null,
    sessions: [],
  },
];

const ctx: MemoContext = {
  preparedFor: '',
  expertName: 'Denise',
  summerYear: '2027',
  forLine: '',
  specialInstructions: 'Keep it warm and concise.',
};

const GOOD_MEMO = {
  title: 'Camp Experts',
  preparedFor: 'Prepared for the family by Denise',
  subtitle: 'Summer 2027 — Camp Recommendations',
  forLine: '',
  table: [
    {
      camp: 'Chestnut Lake',
      location: 'Beach Lake, PA',
      size: '425+',
      sessions: '3 wk',
      coed: 'Co-ed',
      programStyle: 'Balanced',
    },
  ],
  summaries: [
    {
      camp: 'Chestnut Lake',
      header: 'Chestnut Lake — Beach Lake, PA',
      limitedInfo: false,
      lines: [{ label: "Why it's here", text: 'Traditional Wayne County camp.' }],
    },
  ],
};

describe('buildUserPrompt', () => {
  test('includes each camp, the session data, and the special instructions', () => {
    const prompt = buildUserPrompt(camps, ctx);
    expect(prompt).toContain('Chestnut Lake');
    expect(prompt).toContain('3 weeks');
    expect(prompt).toContain('USD 9000');
    expect(prompt).toContain('Keep it warm and concise.');
  });

  test('flags a camp with no write-up as LIMITED INFO', () => {
    const prompt = buildUserPrompt(camps, ctx);
    expect(prompt).toMatch(/NO WRITE-UP ON FILE/i);
    expect(prompt).toContain('Timber Lake West');
  });
});

describe('composeMemo', () => {
  test('returns the normalized memo from a structured response', async () => {
    mockFinal = {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: JSON.stringify(GOOD_MEMO) },
      ],
    };
    const memo = await composeMemo(camps, ctx);
    expect(memo.title).toBe('Camp Experts');
    expect(memo.table).toHaveLength(1);
    expect(memo.summaries[0].header).toContain('Chestnut Lake');
  });

  test('throws on empty camp list', async () => {
    await expect(composeMemo([], ctx)).rejects.toBeInstanceOf(MemoComposeError);
  });

  test('throws MemoComposeError on a safety refusal', async () => {
    mockFinal = { stop_reason: 'refusal', content: [] };
    await expect(composeMemo(camps, ctx)).rejects.toBeInstanceOf(
      MemoComposeError
    );
  });

  test('throws on malformed JSON', async () => {
    mockFinal = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not json at all' }],
    };
    await expect(composeMemo(camps, ctx)).rejects.toBeInstanceOf(
      MemoComposeError
    );
  });
});
