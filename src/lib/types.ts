/** One styled inline run (text or inline image/sticker) inside a reconstructed PDF block. */
export interface DocSpan {
  /** Text content (empty when `img` is present) */
  t: string;
  /** CSS font-family stack with Google-Docs-compatible primary family first */
  ff: string;
  /** Original PDF font name */
  fn: string;
  /** Font size in points (pt) */
  fs: number;
  /** Numeric CSS font-weight (e.g. 400, 500, 600, 700, 800, 900) */
  fw: number;
  /** Bold */
  b: boolean;
  /** Italic / Oblique */
  i: boolean;
  /** Underline */
  u?: boolean;
  /** Strikethrough */
  s?: boolean;
  /** Hex text color, e.g. "#000000" or "#d91a1a" */
  c: string;
  /** Optional hex background highlight color behind this text run */
  bg?: string;
  /** Optional hyperlink URL from PDF Link annotation */
  href?: string;
  /** Optional inline image / sticker / icon anchored on this text line */
  img?: {
    dataUrl: string;
    widthPt: number;
    heightPt: number;
  };
}

export type DocBlock =
  | {
      kind: "paragraph";
      tag: "h1" | "h2" | "h3" | "p";
      align: "left" | "center" | "right";
      /** Line-height multiplier (e.g. 1.38) */
      lineHeight: number;
      /** Left indent relative to page body margin (pt) */
      indentPt: number;
      /** Extra spacing before paragraph (pt) */
      spaceBeforePt: number;
      /** Optional background fill color when paragraph sits inside a colored banner/box */
      bgColor?: string;
      /** True when this block represents an intentional blank line in the PDF */
      blank?: boolean;
      spans: DocSpan[];
    }
  | {
      kind: "table";
      /** Proportional column widths (pt) */
      colWidthsPt: number[];
      spaceBeforePt: number;
      borderColor?: string;
      rows: Array<{
        cells: Array<{
          align: "left" | "center" | "right";
          bgColor?: string;
          spans: DocSpan[];
        }>;
      }>;
    }
  | {
      kind: "image";
      /** Base64 PNG data URL for embedded images / logos / stickers */
      dataUrl: string;
      widthPt: number;
      heightPt: number;
      align: "left" | "center" | "right";
      spaceBeforePt: number;
    }
  | {
      kind: "divider";
      color: string;
      thicknessPt: number;
      spaceBeforePt: number;
    };

export interface ExtractionPayload {
  sourceUrl: string;
  title: string;
  pageCount: number;
  pageWidthPt: number;
  marginLeftPt: number;
  marginRightPt: number;
  fonts: string[];
  imageCount?: number;
  blocks: DocBlock[];
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  pageCount: number;
  itemCount: number;
  createdAt: string;
}
