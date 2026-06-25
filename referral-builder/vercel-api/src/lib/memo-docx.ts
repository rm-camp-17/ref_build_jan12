/**
 * Renders a ComposedMemo to a .docx Buffer, matching the "Conway" memo layout:
 * a header block, an "At a Glance" comparison table, and "Quick Summaries".
 * (The long "Detailed Write-Ups" section of the original is intentionally
 * dropped — that was the "too much detail" we're trimming.)
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ComposedMemo, MemoTableRow } from './memo-compose';

// Camp Experts house accent (terracotta) used on the table header row, matching
// the original artifact.
const ACCENT = 'C47475';
const HEADER_TEXT = 'FFFFFF';
const FLAG = 'B23B3B';

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

/** Build the document model and pack it to a .docx Buffer. */
export async function renderMemoDocx(memo: ComposedMemo): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  // Header block
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({ text: memo.title || 'Camp Experts', bold: true, size: 36, color: ACCENT }),
      ],
    })
  );
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

  // Quick Summaries
  if (memo.summaries.length > 0) {
    children.push(sectionHeading('Quick Summaries'));
    for (const s of memo.summaries) {
      children.push(
        new Paragraph({
          spacing: { before: 160, after: 40 },
          children: [new TextRun({ text: s.header || s.camp, bold: true, size: 24 })],
        })
      );
      if (s.limitedInfo) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [
              new TextRun({
                text: 'Limited info — no write-up on file. Built from structured data; fill in before sending.',
                italics: true,
                color: FLAG,
                size: 18,
              }),
            ],
          })
        );
      }
      for (const line of s.lines) {
        const runs: TextRun[] = [];
        if (line.label) {
          runs.push(new TextRun({ text: `${line.label}: `, bold: true, size: 21 }));
        }
        runs.push(new TextRun({ text: line.text || '', size: 21 }));
        children.push(new Paragraph({ spacing: { after: 40 }, children: runs }));
      }
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
