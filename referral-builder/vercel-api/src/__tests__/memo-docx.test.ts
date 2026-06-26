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
      theFeel: 'A polished, high-energy co-ed camp where kids settle in fast.',
      knownFor: 'Strong waterfront, big-production evening programs, and trips.',
      location: 'Roscoe, NY',
      website: 'https://www.timberlakewest.com',
    },
    {
      camp: 'Mystery Camp',
      theFeel: 'A warm, traditional community with a broad activity menu.',
      knownFor: 'Classic camp staples done well.',
      location: '',
      website: '',
    },
  ],
};

describe('renderMemoDocx', () => {
  test('produces a non-empty .docx (zip) buffer with the embedded logo', async () => {
    const buf = await renderMemoDocx(MEMO);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // The embedded logo PNG (~18KB) makes the package comfortably larger than a
    // text-only memo — a cheap signal that the image actually rendered.
    expect(buf.length).toBeGreaterThan(15000);
    // .docx is a zip — magic bytes "PK".
    expect(buf.slice(0, 2).toString('latin1')).toBe('PK');
  });

  test('embeds the camp website as an external hyperlink', async () => {
    const JSZip = require('jszip');
    const buf = await renderMemoDocx(MEMO);
    const zip = await JSZip.loadAsync(buf);
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    // The website URL is recorded as an external relationship target.
    expect(rels).toContain('https://www.timberlakewest.com');
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
