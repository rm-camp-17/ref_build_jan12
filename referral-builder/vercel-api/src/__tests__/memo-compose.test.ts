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
      effort: 'medium',
      writeupCharCap: 3500,
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
    location: 'Beach Lake, PA',
    website: 'https://www.chestnutlakecamp.com',
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
    location: 'Roscoe, NY',
    website: '',
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
  familyName: 'the Conway Family',
  childrenLine: 'Archie, rising 5th',
  summerYear: '2026',
  preparedBy: 'someone else',
  advisorTake: 'Two strong, warm options with distinct character.',
  table: [
    {
      camp: 'Chestnut Lake',
      location: 'Beach Lake, PA',
      size: 'Mid-sized',
      coed: 'Co-ed',
      sessions: '3 wk',
      bestFor: 'A warm, flexible first sleepaway',
    },
  ],
  summaries: [
    {
      camp: 'Chestnut Lake',
      theFeel: 'A warm, traditional Wayne County camp with a broad activity menu.',
      knownFor: 'Classic camp staples and a strong returning community.',
    },
  ],
};

describe('buildUserPrompt', () => {
  test('includes each camp, its location, the session data, and the instructions', () => {
    const prompt = buildUserPrompt(camps, ctx);
    expect(prompt).toContain('Chestnut Lake');
    expect(prompt).toContain('Beach Lake, PA'); // location fed from our records
    expect(prompt).toContain('3 weeks');
    expect(prompt).toContain('USD 9000');
    expect(prompt).toContain('Keep it warm and concise.');
  });

  test('handles a camp with no write-up without flagging it negatively', () => {
    const prompt = buildUserPrompt(camps, ctx);
    expect(prompt).toMatch(/none on file/i);
    expect(prompt).not.toMatch(/limited info/i);
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
    expect(memo.familyName).toBe('the Conway Family');
    expect(memo.advisorTake).toBeTruthy();
    expect(memo.table).toHaveLength(1);
    expect(memo.table[0].bestFor).toMatch(/first sleepaway/i);
    expect(memo.summaries[0].camp).toBe('Chestnut Lake');
    expect(memo.summaries[0].theFeel).toMatch(/traditional/i);
    expect(memo.summaries[0].knownFor).toBeTruthy();
    // Year + author come from context, overriding whatever the model echoed.
    expect(memo.summerYear).toBe('2027');
    expect(memo.preparedBy).toBe('Denise');
    // Location + website are threaded in from the company record, not the model.
    expect(memo.summaries[0].location).toBe('Beach Lake, PA');
    expect(memo.summaries[0].website).toBe('https://www.chestnutlakecamp.com');
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
