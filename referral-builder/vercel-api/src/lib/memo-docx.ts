/**
 * Renders a ComposedMemo to a polished .docx Buffer: the Camp Experts logo, a
 * compact branded title block, a short "Advisor Take", a clean "At a Glance"
 * comparison table, and per-camp "Quick Summaries". Designed to read like a
 * premium advisor one-pager, not a school report — generous whitespace, subtle
 * rules instead of a heavy grid, and quiet (non-underlined) website links.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import type { ComposedMemo, MemoTableRow, MemoSummary } from './memo-compose';
import { memoLogoBuffer, MEMO_LOGO_WIDTH, MEMO_LOGO_HEIGHT } from './memo-logo';

// Camp Experts house palette.
const ACCENT = 'C47475'; // terracotta
const INK = '1A1A1A'; // near-black body text
const MUTED = '6B6B6B'; // secondary / meta text
const RULE = 'E2E2E2'; // hairline rules
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;

// 5 columns — Size folds in Co-ed so the table breathes instead of cramming six.
const COLUMNS: Array<{ label: string; width: number; cell: (r: MemoTableRow) => string }> = [
  { label: 'Camp', width: 17, cell: (r) => r.camp },
  { label: 'Location', width: 15, cell: (r) => r.location },
  {
    label: 'Size',
    width: 16,
    cell: (r) => [r.size, r.coed].filter(Boolean).join(' · '),
  },
  { label: 'Sessions', width: 19, cell: (r) => r.sessions },
  { label: 'Best For', width: 33, cell: (r) => r.bestFor },
];

const CELL_MARGINS = { top: 70, bottom: 70, left: 120, right: 120 };

function headerCell(label: string, widthPct: number): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    margins: CELL_MARGINS,
    verticalAlign: VerticalAlign.CENTER,
    borders: {
      top: NO_BORDER,
      left: NO_BORDER,
      right: NO_BORDER,
      bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT },
    },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: label.toUpperCase(),
            bold: true,
            color: ACCENT,
            size: 16,
            characterSpacing: 20,
          }),
        ],
      }),
    ],
  });
}

function bodyCell(text: string, widthPct: number, isName: boolean): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    margins: CELL_MARGINS,
    verticalAlign: VerticalAlign.CENTER,
    borders: {
      top: NO_BORDER,
      left: NO_BORDER,
      right: NO_BORDER,
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text || '',
            size: 19,
            bold: isName,
            color: isName ? INK : MUTED,
          }),
        ],
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
        children: COLUMNS.map((c, i) => bodyCell(c.cell(row), c.width, i === 0)),
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
    borders: {
      top: NO_BORDER,
      bottom: NO_BORDER,
      left: NO_BORDER,
      right: NO_BORDER,
      insideHorizontal: NO_BORDER, // per-cell bottom rules instead
      insideVertical: NO_BORDER,
    },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 360, after: 140 },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        color: ACCENT,
        size: 22,
        characterSpacing: 30,
      }),
    ],
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

function firstName(name: string): string {
  return (name || '').trim().split(/\s+/)[0] || '';
}

/** Title block: logo, "Camp Recommendations [for the X Family]", year, kids, author. */
function titleBlock(memo: ComposedMemo): Paragraph[] {
  const out: Paragraph[] = [];

  const logoW = 190;
  const logoH = Math.round((logoW * MEMO_LOGO_HEIGHT) / MEMO_LOGO_WIDTH);
  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [
        new ImageRun({
          type: 'png',
          data: memoLogoBuffer(),
          transformation: { width: logoW, height: logoH },
        }),
      ],
    })
  );

  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 30 },
      children: [
        new TextRun({
          text: `Camp Recommendations${memo.familyName ? ` for ${memo.familyName}` : ''}`,
          bold: true,
          color: ACCENT,
          size: 32,
        }),
      ],
    })
  );

  if (memo.summerYear) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 30 },
        children: [
          new TextRun({ text: `Summer ${memo.summerYear}`, size: 24, color: INK }),
        ],
      })
    );
  }
  if (memo.childrenLine) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 30 },
        children: [
          new TextRun({ text: memo.childrenLine, italics: true, size: 22, color: MUTED }),
        ],
      })
    );
  }
  if (memo.preparedBy) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `Prepared by ${memo.preparedBy}`, size: 20, color: MUTED }),
        ],
      })
    );
  }

  // Hairline rule under the header.
  out.push(
    new Paragraph({
      spacing: { before: 120, after: 0 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
      children: [new TextRun({ text: '', size: 2 })],
    })
  );

  return out;
}

/**
 * One camp's header: bold name, a muted meta line (location · size · co-ed) and
 * a quiet (non-underlined, gray) website link — subtle so it doesn't pull
 * attention from the recommendation.
 */
function summaryHeader(s: MemoSummary, row: MemoTableRow | undefined): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      spacing: { before: 240, after: 20 },
      children: [new TextRun({ text: s.camp, bold: true, size: 25, color: INK })],
    }),
  ];

  const metaBits = [s.location, row?.size, row?.coed].filter(Boolean);
  const metaRuns: Array<TextRun | ExternalHyperlink> = [];
  if (metaBits.length) {
    metaRuns.push(new TextRun({ text: metaBits.join('  ·  '), size: 19, color: MUTED }));
  }
  if (s.website) {
    if (metaRuns.length) {
      metaRuns.push(new TextRun({ text: '   ·   ', size: 19, color: MUTED }));
    }
    metaRuns.push(
      new ExternalHyperlink({
        link: s.website,
        children: [
          // Quiet link: muted gray, no underline (per "reduce blue underlines").
          new TextRun({ text: hostDisplay(s.website) || 'Website', size: 19, color: MUTED }),
        ],
      })
    );
  }
  if (metaRuns.length) {
    out.push(new Paragraph({ spacing: { after: 80 }, children: metaRuns }));
  }
  return out;
}

/** A labeled summary section, e.g. "The feel: ...". */
function summarySection(label: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 70 },
    children: [
      new TextRun({ text: `${label}:  `, bold: true, size: 21, color: ACCENT }),
      new TextRun({ text: text || '', size: 21, color: INK }),
    ],
  });
}

/** Build the document model and pack it to a .docx Buffer. */
export async function renderMemoDocx(memo: ComposedMemo): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  children.push(...titleBlock(memo));

  // Advisor Take — a short, curated framing (neutral; never a ranking).
  if (memo.advisorTake) {
    const takeLabel = memo.preparedBy
      ? `${firstName(memo.preparedBy)}'s Take`
      : 'Advisor Take';
    children.push(sectionHeading(takeLabel));
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: memo.advisorTake, size: 22, color: INK })],
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
    const rowByCamp = new Map<string, MemoTableRow>();
    for (const r of memo.table) rowByCamp.set(normKey(r.camp), r);

    children.push(sectionHeading('Quick Summaries'));
    for (const s of memo.summaries) {
      children.push(...summaryHeader(s, rowByCamp.get(normKey(s.camp))));
      if (s.theFeel) children.push(summarySection('The feel', s.theFeel));
      if (s.knownFor) children.push(summarySection('Known for', s.knownFor));
    }
  }

  const doc = new Document({
    creator: 'Camp Experts Referral Builder',
    title: `Camp Recommendations${memo.familyName ? ` — ${memo.familyName}` : ''}`,
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function normKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Build a filesystem-safe .docx filename for the memo. */
export function memoFileName(memo: ComposedMemo, dealId: string): string {
  const base =
    (memo.familyName || `Camp Recommendations ${dealId}`)
      .replace(/^the\s+/i, '')
      .replace(/[^a-zA-Z0-9 \-_]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || `Camp_Recommendations_${dealId}`;
  const year = memo.summerYear ? `_${memo.summerYear}` : '';
  return `${base}${year}_Camp_Recommendations.docx`;
}
