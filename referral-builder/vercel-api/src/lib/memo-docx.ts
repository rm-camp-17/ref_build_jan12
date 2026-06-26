/**
 * Renders a ComposedMemo to a .docx Buffer: the Camp Experts logo, a short
 * header, an "At a Glance" comparison table, and "Quick Summaries". Each camp's
 * summary uses the same two sections ("The feel" / "Known for") and shows the
 * camp's location and a link to its website next to the name.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ComposedMemo, MemoTableRow, MemoSummary } from './memo-compose';
import { memoLogoBuffer, MEMO_LOGO_WIDTH, MEMO_LOGO_HEIGHT } from './memo-logo';

// Camp Experts house accent (terracotta) used on the table header row, matching
// the original artifact.
const ACCENT = 'C47475';
const HEADER_TEXT = 'FFFFFF';
const LINK_BLUE = '0563C1';

const COLUMNS: Array<{ key: keyof MemoTableRow; label: string; width: number }> = [
  { key: 'camp', label: 'Camp', width: 16 },
  { key: 'location', label: 'Location', width: 14 },
  { key: 'size', label: 'Size', width: 12 },
  { key: 'sessions', label: 'Sessions', width: 22 },
  { key: 'coed', label: 'Co-ed / B-S', width: 14 },
  { key: 'programStyle', label: 'Program Style', width: 22 },
];

function headerCell(label: string, widthPct: number): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: ACCENT },
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: label, bold: true, color: HEADER_TEXT, size: 18 }),
        ],
      }),
    ],
  });
}

function bodyCell(text: string, widthPct: number): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    children: [
      new Paragraph({
        children: [new TextRun({ text: text || '', size: 18 })],
      }),
    ],
  });
}

function buildTable(rows: MemoTableRow[]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: COLUMNS.map((c) => headerCell(c.label, c.width)),
  });
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: COLUMNS.map((c) => bodyCell(String(row[c.key] ?? ''), c.width)),
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
    },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text, bold: true, size: 26 })],
  });
}

/** "https://www.foo.com/x" → "foo.com" for the visible link text. */
function hostDisplay(url: string): string {
  return (url || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * One camp's header line: bold name, location, and a website link "next to the
 * name". Renders as: "Chestnut Lake — Beach Lake, PA · chestnutlakecamp.com"
 * (the domain hyperlinked).
 */
function summaryHeader(s: MemoSummary): Paragraph {
  const children: Array<TextRun | ExternalHyperlink> = [
    new TextRun({ text: s.camp, bold: true, size: 24 }),
  ];
  if (s.location) {
    children.push(new TextRun({ text: `  —  ${s.location}`, size: 22 }));
  }
  if (s.website) {
    children.push(new TextRun({ text: '   ·   ', size: 22, color: '999999' }));
    children.push(
      new ExternalHyperlink({
        link: s.website,
        children: [
          new TextRun({
            text: hostDisplay(s.website) || 'Website',
            size: 21,
            color: LINK_BLUE,
            underline: {},
          }),
        ],
      })
    );
  }
  return new Paragraph({ spacing: { before: 200, after: 40 }, children });
}

/** A labeled summary section, e.g. "The feel: ...". */
function summarySection(label: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 21 }),
      new TextRun({ text: text || '', size: 21 }),
    ],
  });
}

/** Build the document model and pack it to a .docx Buffer. */
export async function renderMemoDocx(memo: ComposedMemo): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  // Logo (the Camp Experts wordmark) — scaled to a header size, aspect kept.
  const logoW = 230;
  const logoH = Math.round((logoW * MEMO_LOGO_HEIGHT) / MEMO_LOGO_WIDTH);
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new ImageRun({
          type: 'png',
          data: memoLogoBuffer(),
          transformation: { width: logoW, height: logoH },
        }),
      ],
    })
  );

  // Header block
  if (memo.preparedFor) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: memo.preparedFor, size: 22 })],
      })
    );
  }
  if (memo.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: memo.subtitle, bold: true, size: 24 })],
      })
    );
  }
  if (memo.forLine) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: memo.forLine, italics: true, size: 22 })],
      })
    );
  }

  // At a Glance
  if (memo.table.length > 0) {
    children.push(sectionHeading('At a Glance'));
    children.push(buildTable(memo.table));
  }

  // Quick Summaries — same two sections for every camp.
  if (memo.summaries.length > 0) {
    children.push(sectionHeading('Quick Summaries'));
    for (const s of memo.summaries) {
      children.push(summaryHeader(s));
      if (s.theFeel) children.push(summarySection('The feel', s.theFeel));
      if (s.knownFor) children.push(summarySection('Known for', s.knownFor));
    }
  }

  const doc = new Document({
    creator: 'Camp Experts Referral Builder',
    title: memo.subtitle || 'Camp Recommendations',
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

/** Build a filesystem-safe .docx filename for the memo. */
export function memoFileName(memo: ComposedMemo, dealId: string): string {
  const base =
    (memo.preparedFor || memo.subtitle || `Camp Recommendations ${dealId}`)
      .replace(/^prepared for\s+/i, '')
      .replace(/\s+by\s+.*$/i, '')
      .replace(/[^a-zA-Z0-9 \-_]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || `Camp_Recommendations_${dealId}`;
  return `${base}_Camp_Recommendations.docx`;
}
