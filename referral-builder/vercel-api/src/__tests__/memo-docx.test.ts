/**
 * Smoke test for the .docx renderer: a ComposedMemo packs to a non-empty,
 * valid Office Open XML (zip) buffer, and the filename helper sanitizes.
 */

import { renderMemoDocx, memoFileName } from '../lib/memo-docx';
import type { ComposedMemo } from '../lib/memo-compose';

const MEMO: ComposedMemo = {
  title: 'Camp Experts',
  preparedFor: 'Prepared for the Conway Family by Denise',
  subtitle: 'Summer 2027 — Camp Recommendations',
  forLine: 'For Archie (rising 5th) and Luke (rising 3rd)',
  table: [
    {
      camp: 'Timber Lake West',
      location: 'Roscoe, NY',
      size: '280–325',
      sessions: '4 wk / 3 wk',
      coed: 'Co-ed',
      programStyle: 'Highly structured',
    },
    {
      camp: 'Chestnut Lake',
      location: 'Beach Lake, PA',
      size: '425+',
      sessions: '3 wk / 4 wk',
      coed: 'Co-ed',
      programStyle: 'Balanced',
    },
  ],
  summaries: [
    {
      camp: 'Timber Lake West',
      header: 'Timber Lake West — Roscoe, NY',
      limitedInfo: false,
      lines: [
        { label: "Why it's a top pick", text: 'Co-ed, mid-sized, structured.' },
        { label: 'Water', text: 'Two heated pools; instructional swim required.' },
      ],
    },
    {
      camp: 'Mystery Camp',
      header: 'Mystery Camp',
      limitedInfo: true,
      lines: [{ label: '', text: 'Built from structured data only.' }],
    },
  ],
};

describe('renderMemoDocx', () => {
  test('produces a non-empty .docx (zip) buffer', async () => {
    const buf = await renderMemoDocx(MEMO);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .docx is a zip — magic bytes "PK".
    expect(buf.slice(0, 2).toString('latin1')).toBe('PK');
  });

  test('renders even with empty table / summaries', async () => {
    const buf = await renderMemoDocx({
      ...MEMO,
      table: [],
      summaries: [],
    });
    expect(buf.length).toBeGreaterThan(0);
  });
});

describe('memoFileName', () => {
  test('derives a sanitized .docx filename from the header', () => {
    const name = memoFileName(MEMO, '123');
    expect(name.endsWith('.docx')).toBe(true);
    expect(name).not.toMatch(/[^a-zA-Z0-9_.\-]/);
  });

  test('falls back to the deal id when no header text', () => {
    const name = memoFileName(
      { ...MEMO, preparedFor: '', subtitle: '' },
      '999'
    );
    expect(name).toContain('999');
  });
});
