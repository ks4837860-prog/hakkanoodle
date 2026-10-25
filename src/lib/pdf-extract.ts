import path from "node:path";
import { deflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocBlock, DocSpan, ExtractionPayload } from "@/lib/types";

const MAX_PAGES = 80;

/* ═══════════ PURE-NODE PNG ENCODER FOR EMBEDDED PDF IMAGES & STICKERS ═══════════ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function encodeRgbaToPngDataUrl(
  rgba: Uint8Array,
  width: number,
  height: number
): string {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter None
    const srcOff = y * width * 4;
    raw.set(rgba.subarray(srcOff, srcOff + width * 4), rowOff + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw, { level: 6 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length === 6) {
    return [
      parseInt(h.slice(0, 2), 16) || 0,
      parseInt(h.slice(2, 4), 16) || 0,
      parseInt(h.slice(4, 6), 16) || 0,
    ];
  }
  return [0, 0, 0];
}

function pdfImageToDataUrl(
  img: {
    width?: number;
    height?: number;
    data?: Uint8Array | Uint8ClampedArray;
    kind?: number;
  },
  maskColorHex?: string
): string | null {
  const srcW = img?.width ?? 0;
  const srcH = img?.height ?? 0;
  const data = img?.data;
  if (!srcW || !srcH || !data || data.length === 0) return null;

  const step = Math.max(1, Math.ceil(Math.max(srcW, srcH) / 900));
  const outW = Math.max(1, Math.floor(srcW / step));
  const outH = Math.max(1, Math.floor(srcH / step));
  const rgba = new Uint8Array(outW * outH * 4);
  const kind = img.kind ?? 3; // 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  const [mr, mg, mb] = maskColorHex ? hexToRgb(maskColorHex) : [0, 0, 0];

  let visibleNonWhitePixels = 0;
  const rowByteStride1Bpp = (srcW + 7) >> 3;

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(srcH - 1, y * step);
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(srcW - 1, x * step);
      const di = (y * outW + x) * 4;
      let r = 255,
        g = 255,
        b = 255,
        a = 255;
      if (kind === 3) {
        const si = (sy * srcW + sx) * 4;
        r = data[si];
        g = data[si + 1];
        b = data[si + 2];
        a = data[si + 3];
      } else if (kind === 2) {
        const si = (sy * srcW + sx) * 3;
        r = data[si];
        g = data[si + 1];
        b = data[si + 2];
      } else if (kind === 1) {
        const byte = data[sy * rowByteStride1Bpp + (sx >> 3)] ?? 0;
        const bit = (byte >> (7 - (sx & 7))) & 1;
        if (maskColorHex) {
          // Stencil mask: 0 = painted with current fill color, 1 = transparent
          r = mr;
          g = mg;
          b = mb;
          a = bit === 0 ? 255 : 0;
        } else {
          r = g = b = bit ? 255 : 0;
        }
      }
      rgba[di] = r;
      rgba[di + 1] = g;
      rgba[di + 2] = b;
      rgba[di + 3] = a;
      if (a > 16 && (r < 250 || g < 250 || b < 250)) visibleNonWhitePixels++;
    }
  }
  if (visibleNonWhitePixels === 0) return null;
  return encodeRgbaToPngDataUrl(rgba, outW, outH);
}

/* ═══════════ EMBEDDED OPENTYPE / TRUETYPE BINARY FONT INSPECTOR ═══════════ */
interface SfntInspection {
  familyName?: string;
  subfamilyName?: string;
  weightClass?: number;
  bold?: boolean;
  italic?: boolean;
}

function readUtf16BE(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length - 1, offset + length);
  for (let i = offset; i < end; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code >= 32 && code < 0xd800) out += String.fromCharCode(code);
  }
  return out.trim();
}

function inspectSfntFont(data?: Uint8Array): SfntInspection {
  if (!data || data.byteLength < 16) return {};
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sig = dv.getUint32(0);
    // 0x00010000 (TrueType), 0x4F54544F ('OTTO' CFF), 0x74727565 ('true')
    if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) {
      return {};
    }
    const numTables = dv.getUint16(4);
    if (numTables === 0 || numTables > 64 || 12 + numTables * 16 > data.byteLength) {
      return {};
    }
    const tables: Record<string, { offset: number; length: number }> = {};
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(
        dv.getUint8(rec),
        dv.getUint8(rec + 1),
        dv.getUint8(rec + 2),
        dv.getUint8(rec + 3)
      );
      const offset = dv.getUint32(rec + 8);
      const length = dv.getUint32(rec + 12);
      if (offset + length <= data.byteLength) {
        tables[tag] = { offset, length };
      }
    }

    const res: SfntInspection = {};
    if (tables["OS/2"] && tables["OS/2"].length >= 64) {
      const o = tables["OS/2"].offset;
      const w = dv.getUint16(o + 4);
      if (w >= 100 && w <= 950) {
        res.weightClass = w;
        if (w >= 600) res.bold = true;
      }
      const fsSel = dv.getUint16(o + 62);
      if (fsSel & 0x20) res.bold = true;
      if (fsSel & 0x01 || fsSel & 0x200) res.italic = true;
    }

    if (tables["head"] && tables["head"].length >= 46) {
      const macStyle = dv.getUint16(tables["head"].offset + 44);
      if (macStyle & 0x01) res.bold = true;
      if (macStyle & 0x02) res.italic = true;
    }

    if (tables["post"] && tables["post"].length >= 8) {
      const italicFixed = dv.getInt32(tables["post"].offset + 4);
      const angle = italicFixed / 65536;
      if (Math.abs(angle) >= 2 && Math.abs(angle) <= 45) res.italic = true;
    }

    if (tables["name"] && tables["name"].length >= 6) {
      const o = tables["name"].offset;
      const count = dv.getUint16(o + 2);
      const strBase = o + dv.getUint16(o + 4);
      for (let i = 0; i < Math.min(count, 80); i++) {
        const nr = o + 6 + i * 12;
        if (nr + 12 > o + tables["name"].length) break;
        const platformID = dv.getUint16(nr);
        const nameID = dv.getUint16(nr + 6);
        const len = dv.getUint16(nr + 8);
        const strOff = strBase + dv.getUint16(nr + 10);
        if (strOff + len > data.byteLength || len === 0) continue;
        if (nameID !== 1 && nameID !== 2 && nameID !== 16 && nameID !== 17) continue;

        let val = "";
        if (platformID === 3 || platformID === 0) {
          val = readUtf16BE(data, strOff, len);
        } else if (platformID === 1) {
          val = new TextDecoder("latin1")
            .decode(data.subarray(strOff, strOff + len))
            .replace(/\0/g, "")
            .trim();
        }
        if (!val) continue;
        const cleanVal = val.replace(/^[A-Z]{6}\+/, "").trim();
        if ((nameID === 16 || nameID === 1) && (!res.familyName || nameID === 16)) {
          res.familyName = cleanVal;
        }
        if ((nameID === 17 || nameID === 2) && (!res.subfamilyName || nameID === 17)) {
          res.subfamilyName = cleanVal;
        }
      }
      if (res.subfamilyName) {
        if (/bold|black|heavy|semibold|demibold|extrabold|ultrabold/i.test(res.subfamilyName)) {
          res.bold = true;
          if (!res.weightClass || res.weightClass < 600) {
            res.weightClass = /semibold|demibold/i.test(res.subfamilyName) ? 600 : 700;
          }
        }
        if (/italic|oblique|slanted/i.test(res.subfamilyName)) {
          res.italic = true;
        }
      }
    }

    return res;
  } catch {
    return {};
  }
}

/* ═══════════ GOOGLE-DOCS-COMPATIBLE FONT STACK MAPPING ═══════════ */
function cssFontStack(rawName: string, genericFamily: string): string {
  const clean = rawName.replace(/^[A-Z]{6}\+/, "").trim();
  const n = clean.toLowerCase();

  const known: Array<[RegExp, string]> = [
    [/^helvetica/, "Helvetica, Arial, sans-serif"],
    [/arial/, "Arial, sans-serif"],
    [/verdana/, "Verdana, sans-serif"],
    [/times/, "'Times New Roman', serif"],
    [/calibri/, "Calibri, Arial, sans-serif"],
    [/cambria/, "Cambria, Georgia, serif"],
    [/georgia/, "Georgia, serif"],
    [/courier|consolas|menlo|monaco|fira\s*code|mono/, "'Courier New', monospace"],
    [/tahoma/, "Tahoma, sans-serif"],
    [/trebuchet/, "'Trebuchet MS', sans-serif"],
    [/garamond/, "Garamond, Georgia, serif"],
    [/roboto/, "Roboto, Arial, sans-serif"],
    [/open\s*sans/, "'Open Sans', Arial, sans-serif"],
    [/lato/, "Lato, Arial, sans-serif"],
    [/montserrat/, "Montserrat, Arial, sans-serif"],
    [/poppins/, "Poppins, Arial, sans-serif"],
    [/raleway/, "Raleway, Arial, sans-serif"],
    [/nunito/, "Nunito, Arial, sans-serif"],
    [/merriweather/, "Merriweather, Georgia, serif"],
    [/playfair/, "'Playfair Display', Georgia, serif"],
    [/oswald/, "Oswald, Arial, sans-serif"],
    [/ubuntu/, "Ubuntu, Arial, sans-serif"],
    [/inter\b/, "Inter, Arial, sans-serif"],
    [/comic\s*sans/, "'Comic Sans MS', cursive, sans-serif"],
    [/impact/, "Impact, Arial, sans-serif"],
    [/palatino|book\s*antiqua/, "'Palatino Linotype', Georgia, serif"],
    [/pgothic|gothic|mincho|meiryo/, "'MS PGothic', 'Noto Sans Symbols', Arial, sans-serif"],
    [/symbol|dingbat|wingding|emoji|zapf/, "'Noto Sans Symbols', 'Segoe UI Symbol', 'Apple Color Emoji', Arial, sans-serif"],
    [/century|bookman/, "Georgia, serif"],
  ];
  for (const [re, stack] of known) {
    if (re.test(n)) return stack;
  }

  const base = clean
    .replace(
      /[-,_ ]?(BoldItalic|BoldOblique|ExtraBold|UltraBold|SemiBold|DemiBold|Bold|Italic|Oblique|Regular|Roman|Medium|Light|Thin|Black|Heavy|Book|MT|PSMT|PS|Std|Pro).*$/i,
      ""
    )
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();

  const generic =
    genericFamily === "serif"
      ? "Georgia, serif"
      : genericFamily === "monospace"
        ? "'Courier New', monospace"
        : "Arial, sans-serif";

  if (base && /^[A-Za-z0-9 ]+$/.test(base)) {
    return base.includes(" ") ? `'${base}', ${generic}` : `${base}, ${generic}`;
  }
  return generic;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mulMat(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function transformBox(
  ctm: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] {
  const pts: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [px, py] of pts) {
    const wx = ctm[0] * px + ctm[2] * py + ctm[4];
    const wy = ctm[1] * px + ctm[3] * py + ctm[5];
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
  }
  return [minX, minY, maxX, maxY];
}

function toHexByte(v: number): string {
  const n = Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v)));
  return n.toString(16).padStart(2, "0");
}

function parseColorArgs(args: unknown[]): string {
  if (!args || args.length === 0) return "#000000";
  if (typeof args[0] === "string" && args[0].startsWith("#")) {
    return args[0].toLowerCase().slice(0, 7);
  }
  const nums = args.filter((x): x is number => typeof x === "number");
  if (nums.length === 1) {
    const h = toHexByte(nums[0]);
    return `#${h}${h}${h}`;
  }
  if (nums.length === 3) {
    return `#${toHexByte(nums[0])}${toHexByte(nums[1])}${toHexByte(nums[2])}`;
  }
  if (nums.length >= 4) {
    const [c, m, yk, k] = nums;
    const r = 255 * (1 - c) * (1 - k);
    const g = 255 * (1 - m) * (1 - k);
    const b = 255 * (1 - yk) * (1 - k);
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  }
  return "#000000";
}

function isNearWhite(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return r >= 248 && g >= 248 && b >= 248;
}

interface FontMeta {
  name: string;
  weight: number;
  bold: boolean;
  italic: boolean;
  generic: string;
}

interface RawRun {
  t: string;
  x: number;
  y: number;
  w: number;
  fs: number;
  fw: number;
  ff: string;
  fn: string;
  b: boolean;
  i: boolean;
  u?: boolean;
  s?: boolean;
  c: string;
  bg?: string;
  href?: string;
  img?: {
    dataUrl: string;
    widthPt: number;
    heightPt: number;
  };
}

interface GlyphStyleSample {
  x0: number;
  x1: number;
  y: number;
  color: string;
  synBold: boolean;
}

interface DrawnLine {
  x0: number;
  x1: number;
  midY: number;
  thickness: number;
  color: string;
  consumed?: boolean;
}

interface FilledRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
}

interface StrokedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
}

interface LinkBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  url: string;
}

interface PlacedImage {
  dataUrl: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  widthPt: number;
  heightPt: number;
  consumedInline?: boolean;
}

function appendSpan(target: DocSpan[], next: DocSpan) {
  if (!next.img && !next.t) return;
  if (next.img) {
    target.push({ ...next });
    return;
  }
  const prev = target[target.length - 1];
  if (
    prev &&
    !prev.img &&
    prev.ff === next.ff &&
    Math.abs(prev.fs - next.fs) < 0.25 &&
    prev.fw === next.fw &&
    prev.b === next.b &&
    prev.i === next.i &&
    Boolean(prev.u) === Boolean(next.u) &&
    Boolean(prev.s) === Boolean(next.s) &&
    prev.c === next.c &&
    (prev.bg || "") === (next.bg || "") &&
    (prev.href || "") === (next.href || "")
  ) {
    prev.t += next.t;
  } else {
    target.push({ ...next });
  }
}

interface VisualLine {
  y: number;
  startX: number;
  endX: number;
  maxFs: number;
  runs: RawRun[];
}

function groupIntoVisualLines(runs: RawRun[]): VisualLine[] {
  const nonEmpty = runs.filter((r) => r.img || r.t.length > 0);
  if (nonEmpty.length === 0) return [];
  const sorted = [...nonEmpty].sort((a, b) => b.y - a.y || a.x - b.x);
  const buckets: RawRun[][] = [];
  for (const r of sorted) {
    const last = buckets[buckets.length - 1];
    if (last) {
      const ref = last[0];
      const tol = Math.max(2.0, Math.min(ref.fs, r.fs) * 0.48);
      if (Math.abs(ref.y - r.y) <= tol) {
        last.push(r);
        continue;
      }
    }
    buckets.push([r]);
  }
  return buckets.map((b) => {
    b.sort((x, y) => x.x - y.x);
    let startX = Infinity;
    let endX = -Infinity;
    let maxFs = 9;
    for (const r of b) {
      if (r.img || r.t.trim().length > 0) {
        startX = Math.min(startX, r.x);
        endX = Math.max(endX, r.x + r.w);
      }
      maxFs = Math.max(maxFs, r.fs);
    }
    if (!isFinite(startX)) {
      startX = b[0].x;
      endX = b[b.length - 1].x + b[b.length - 1].w;
    }
    return { y: b[0].y, startX, endX, maxFs, runs: b };
  });
}

function lineRunsToSpans(runs: RawRun[]): DocSpan[] {
  const spans: DocSpan[] = [];
  let prevEndX: number | null = null;
  let prevFs = 10;

  for (const r of runs) {
    if (r.img) {
      if (prevEndX !== null && spans.length > 0) {
        const gap = r.x - prevEndX;
        const prevSpan = spans[spans.length - 1];
        if (!prevSpan.img && gap > prevFs * 0.22 && !/\s$/.test(prevSpan.t)) {
          prevSpan.t += " ";
        }
      }
      appendSpan(spans, {
        t: "",
        ff: r.ff,
        fn: r.fn,
        fs: r.fs,
        fw: r.fw,
        b: r.b,
        i: r.i,
        c: r.c,
        img: r.img,
      });
      prevEndX = Math.max(prevEndX ?? 0, r.x + r.w);
      continue;
    }

    let text = r.t;
    if (prevEndX !== null && spans.length > 0) {
      const gap = r.x - prevEndX;
      const prevSpan = spans[spans.length - 1];
      const minFs = Math.min(prevFs, r.fs);
      if (
        gap > minFs * 0.18 &&
        (prevSpan.img || !/\s$/.test(prevSpan.t)) &&
        !/^\s/.test(text)
      ) {
        text = " " + text;
      }
    }
    if (
      /^\s+$/.test(text) &&
      spans.length > 0 &&
      !spans[spans.length - 1].img &&
      /\s$/.test(spans[spans.length - 1].t)
    ) {
      prevEndX = Math.max(prevEndX ?? r.x, r.x + r.w);
      continue;
    }
    appendSpan(spans, {
      t: text,
      ff: r.ff,
      fn: r.fn,
      fs: r.fs,
      fw: r.fw,
      b: r.b,
      i: r.i,
      u: r.u,
      s: r.s,
      c: r.c,
      bg: r.bg,
      href: r.href,
    });
    prevEndX = Math.max(prevEndX ?? 0, r.x + r.w);
    prevFs = r.fs;
  }
  if (spans.length > 0 && !spans[spans.length - 1].img) {
    spans[spans.length - 1].t = spans[spans.length - 1].t.replace(/[ \t]+$/, "");
  }
  return spans;
}

function detectAlignment(
  lines: VisualLine[],
  pageWidth: number,
  bodyLeft: number,
  bodyRight: number
): "left" | "center" | "right" {
  if (lines.length === 0) return "left";
  const pageMid = pageWidth / 2;
  const bodyMid = (bodyLeft + bodyRight) / 2;
  let centeredCount = 0;
  let rightCount = 0;
  for (const ln of lines) {
    const lineW = ln.endX - ln.startX;
    if (lineW > (bodyRight - bodyLeft) * 0.86) continue;
    const mid = (ln.startX + ln.endX) / 2;
    if (
      ln.startX > bodyLeft + 24 &&
      (Math.abs(mid - pageMid) < 18 || Math.abs(mid - bodyMid) < 18)
    ) {
      centeredCount++;
    } else if (ln.startX > bodyLeft + 60 && Math.abs(ln.endX - bodyRight) < 16) {
      rightCount++;
    }
  }
  if (centeredCount > 0 && centeredCount >= lines.length * 0.6) return "center";
  if (rightCount > 0 && rightCount >= lines.length * 0.6) return "right";
  return "left";
}

const BLOCK_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "LI", "LBody", "BlockQuote", "Caption", "TD", "TH",
]);

function mapTag(pdfTag: string): "h1" | "h2" | "h3" | "p" {
  const u = pdfTag.toUpperCase();
  if (u === "H1") return "h1";
  if (u === "H2") return "h2";
  if (u === "H3" || u === "H4" || u === "H5" || u === "H6") return "h3";
  return "p";
}

export async function extractPdf(
  buffer: ArrayBuffer,
  sourceUrl: string
): Promise<ExtractionPayload> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl:
      path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") +
      path.sep,
    useSystemFonts: false, // Ensure embedded font data bytes remain accessible for OS/2 bold/italic inspection
    fontExtraProperties: true,
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  let title = "";
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: string } | undefined;
    if (info?.Title && info.Title.trim()) title = info.Title.trim();
  } catch {
    /* optional */
  }
  if (!title) {
    try {
      const u = new URL(sourceUrl);
      title = decodeURIComponent(u.pathname.split("/").pop() || u.hostname).replace(
        /\.pdf$/i,
        ""
      );
    } catch {
      title = "document";
    }
  }

  const fontSet = new Set<string>();
  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const allBlocks: DocBlock[] = [];
  let totalEmbeddedImages = 0;
  let docWidthPt = 596;
  let minBodyX = Infinity;
  let maxBodyRightX = 0;

  let prevPageEndMeta: {
    blockIdx: number;
    lastLineEndX: number;
    pageWidth: number;
    fs: number;
  } | null = null;

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    docWidthPt = round2(viewport.width);

    /* ── 0. Link Annotations (clickable URLs in PDF) ── */
    const linkBoxes: LinkBox[] = [];
    try {
      const annots = await page.getAnnotations();
      for (const a of annots as Array<{
        subtype?: string;
        url?: string;
        unsafeUrl?: string;
        rect?: number[];
      }>) {
        const href = a.url || a.unsafeUrl;
        if (a.subtype === "Link" && href && Array.isArray(a.rect) && a.rect.length >= 4) {
          const [rx0, ry0, rx1, ry1] = a.rect;
          linkBoxes.push({
            x0: Math.min(rx0, rx1),
            y0: Math.min(ry0, ry1),
            x1: Math.max(rx0, rx1),
            y1: Math.max(ry0, ry1),
            url: href,
          });
        }
      }
    } catch {
      /* optional */
    }

    /* ── 1. Operator Pass: Per-Glyph Colors, Synthetic Bold, Highlights, Underlines, Dividers & Images ── */
    const glyphSamples: GlyphStyleSample[] = [];
    const drawnLines: DrawnLine[] = [];
    const filledRects: FilledRect[] = [];
    const strokedRects: StrokedRect[] = [];
    const placedImages: PlacedImage[] = [];
    const distinctTextColors = new Set<string>();
    let anySyntheticBold = false;

    try {
      const ops = await page.getOperatorList();
      interface GState {
        ctm: number[];
        fillColor: string;
        strokeColor: string;
        fillAlpha: number;
        lineWidth: number;
        trm: number;
        fontSize: number;
        charSpacing: number;
        wordSpacing: number;
        hScale: number;
        leading: number;
      }
      const cloneState = (s: GState): GState => ({ ...s, ctm: [...s.ctm] });
      const gStack: GState[] = [
        {
          ctm: [1, 0, 0, 1, 0, 0],
          fillColor: "#000000",
          strokeColor: "#000000",
          fillAlpha: 1,
          lineWidth: 1,
          trm: 0,
          fontSize: 12,
          charSpacing: 0,
          wordSpacing: 0,
          hScale: 1,
          leading: 0,
        },
      ];
      let cur = gStack[0];
      let inText = false;
      let tm = [1, 0, 0, 1, 0, 0];
      let tlm = [1, 0, 0, 1, 0, 0];
      let pendingRect: [number, number, number, number] | null = null;

      const recordPathBox = (
        paintOp: number,
        lx0: number,
        ly0: number,
        lx1: number,
        ly1: number
      ) => {
        const [x0, y0, x1, y1] = transformBox(cur.ctm, lx0, ly0, lx1, ly1);
        const w = x1 - x0;
        const h = y1 - y0;
        const isFill =
          paintOp === pdfjs.OPS.fill ||
          paintOp === pdfjs.OPS.eoFill ||
          paintOp === pdfjs.OPS.fillStroke ||
          paintOp === pdfjs.OPS.eoFillStroke ||
          paintOp === pdfjs.OPS.closeFillStroke ||
          paintOp === pdfjs.OPS.closeEOFillStroke;
        const isStroke =
          paintOp === pdfjs.OPS.stroke ||
          paintOp === pdfjs.OPS.closeStroke ||
          paintOp === pdfjs.OPS.fillStroke ||
          paintOp === pdfjs.OPS.eoFillStroke ||
          paintOp === pdfjs.OPS.closeFillStroke ||
          paintOp === pdfjs.OPS.closeEOFillStroke;

        // Ignore full-page white background canvas fills
        if (w > viewport.width * 0.92 && h > viewport.height * 0.92 && isNearWhite(cur.fillColor)) {
          return;
        }

        // Thin horizontal line or bar -> Underline, Strikethrough, or Horizontal Rule
        if (h <= 3.4 && w >= 4) {
          const lineCol = isFill ? cur.fillColor : cur.strokeColor;
          if (!isNearWhite(lineCol)) {
            drawnLines.push({
              x0,
              x1,
              midY: (y0 + y1) / 2,
              thickness: Math.max(0.75, h || cur.lineWidth),
              color: lineCol,
            });
          }
          return;
        }

        if (isFill && w >= 3 && h >= 4 && cur.fillAlpha > 0.04 && !isNearWhite(cur.fillColor)) {
          filledRects.push({ x0, y0, x1, y1, color: cur.fillColor });
        }
        if (isStroke && w >= 14 && h >= 8 && !isNearWhite(cur.strokeColor)) {
          strokedRects.push({ x0, y0, x1, y1, color: cur.strokeColor });
        }
      };

      const getImgObject = (idOrData: unknown) => {
        if (!idOrData) return null;
        if (typeof idOrData === "object") return idOrData as Record<string, unknown>;
        if (typeof idOrData === "string") {
          return (
            idOrData.startsWith("g_")
              ? page.commonObjs.get(idOrData)
              : page.objs.get(idOrData)
          ) as Record<string, unknown> | undefined;
        }
        return null;
      };

      const recordImageAtCtm = (
        imgObj: Record<string, unknown> | null | undefined,
        ctm: number[],
        maskColor?: string
      ) => {
        if (!imgObj || placedImages.length >= 60) return;
        const [x0, y0, x1, y1] = transformBox(ctm, 0, 0, 1, 1);
        const wPt = x1 - x0;
        const hPt = y1 - y0;
        if (
          wPt < 4 ||
          hPt < 4 ||
          (wPt > viewport.width * 0.96 && hPt > viewport.height * 0.96)
        ) {
          return;
        }
        const dataUrl = pdfImageToDataUrl(
          imgObj as {
            width?: number;
            height?: number;
            data?: Uint8Array;
            kind?: number;
          },
          maskColor
        );
        if (!dataUrl) return;
        placedImages.push({
          dataUrl,
          x0: round2(x0),
          y0: round2(y0),
          x1: round2(x1),
          y1: round2(y1),
          widthPt: round2(Math.min(wPt, viewport.width - 72)),
          heightPt: round2(hPt),
        });
      };

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = (ops.argsArray[i] as unknown[]) || [];

        if (fn === pdfjs.OPS.save) {
          gStack.push(cloneState(cur));
          cur = gStack[gStack.length - 1];
        } else if (fn === pdfjs.OPS.restore) {
          if (gStack.length > 1) gStack.pop();
          cur = gStack[gStack.length - 1];
        } else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
          gStack.push(cloneState(cur));
          cur = gStack[gStack.length - 1];
          if (Array.isArray(args[0]) && args[0].length === 6) {
            cur.ctm = mulMat(cur.ctm, args[0] as number[]);
          }
        } else if (fn === pdfjs.OPS.paintFormXObjectEnd) {
          if (gStack.length > 1) gStack.pop();
          cur = gStack[gStack.length - 1];
        } else if (fn === pdfjs.OPS.transform) {
          cur.ctm = mulMat(cur.ctm, args as number[]);
        } else if (
          fn === pdfjs.OPS.setFillRGBColor ||
          fn === pdfjs.OPS.setFillGray ||
          fn === pdfjs.OPS.setFillCMYKColor ||
          fn === pdfjs.OPS.setFillColor ||
          fn === pdfjs.OPS.setFillColorN
        ) {
          cur.fillColor = parseColorArgs(args);
        } else if (
          fn === pdfjs.OPS.setStrokeRGBColor ||
          fn === pdfjs.OPS.setStrokeGray ||
          fn === pdfjs.OPS.setStrokeCMYKColor ||
          fn === pdfjs.OPS.setStrokeColor ||
          fn === pdfjs.OPS.setStrokeColorN
        ) {
          cur.strokeColor = parseColorArgs(args);
        } else if (fn === pdfjs.OPS.setLineWidth) {
          if (typeof args[0] === "number") cur.lineWidth = args[0];
        } else if (fn === pdfjs.OPS.setGState && Array.isArray(args[0])) {
          for (const entry of args[0] as Array<[string, unknown]>) {
            if (entry[0] === "ca" && typeof entry[1] === "number") {
              cur.fillAlpha = entry[1];
            }
          }
        } else if (fn === pdfjs.OPS.setTextRenderingMode) {
          cur.trm = typeof args[0] === "number" ? args[0] : 0;
        } else if (fn === pdfjs.OPS.setFont) {
          if (typeof args[1] === "number") cur.fontSize = args[1];
        } else if (fn === pdfjs.OPS.setCharSpacing) {
          if (typeof args[0] === "number") cur.charSpacing = args[0];
        } else if (fn === pdfjs.OPS.setWordSpacing) {
          if (typeof args[0] === "number") cur.wordSpacing = args[0];
        } else if (fn === pdfjs.OPS.setHScale) {
          if (typeof args[0] === "number") cur.hScale = args[0] / 100;
        } else if (fn === pdfjs.OPS.setLeading) {
          if (typeof args[0] === "number") cur.leading = args[0];
        } else if (fn === pdfjs.OPS.rectangle && args.length >= 4) {
          const [rx, ry, rw, rh] = args as number[];
          pendingRect = [rx, ry, rx + rw, ry + rh];
        } else if (
          pendingRect &&
          (fn === pdfjs.OPS.fill ||
            fn === pdfjs.OPS.eoFill ||
            fn === pdfjs.OPS.stroke ||
            fn === pdfjs.OPS.closeStroke ||
            fn === pdfjs.OPS.fillStroke ||
            fn === pdfjs.OPS.eoFillStroke)
        ) {
          recordPathBox(fn, pendingRect[0], pendingRect[1], pendingRect[2], pendingRect[3]);
          pendingRect = null;
        } else if (fn === pdfjs.OPS.endPath) {
          pendingRect = null;
        } else if (fn === pdfjs.OPS.constructPath && args.length >= 3 && args[2]) {
          const paintOp = args[0] as number;
          const mm = args[2] as Record<number, number> | number[];
          const lx0 = mm[0],
            ly0 = mm[1],
            lx1 = mm[2],
            ly1 = mm[3];
          if (
            typeof lx0 === "number" &&
            typeof ly0 === "number" &&
            typeof lx1 === "number" &&
            typeof ly1 === "number" &&
            isFinite(lx0) &&
            isFinite(ly0) &&
            isFinite(lx1) &&
            isFinite(ly1)
          ) {
            recordPathBox(paintOp, lx0, ly0, lx1, ly1);
          }
        } else if (fn === pdfjs.OPS.beginText) {
          inText = true;
          tm = [1, 0, 0, 1, 0, 0];
          tlm = [1, 0, 0, 1, 0, 0];
        } else if (fn === pdfjs.OPS.endText) {
          inText = false;
        } else if (fn === pdfjs.OPS.setTextMatrix && inText) {
          const rawM = args[0] as Record<string, number> | number[];
          const m = Array.isArray(rawM)
            ? rawM
            : [rawM[0], rawM[1], rawM[2], rawM[3], rawM[4], rawM[5]];
          tm = [...m];
          tlm = [...m];
        } else if (
          (fn === pdfjs.OPS.moveText || fn === pdfjs.OPS.setLeadingMoveText) &&
          inText
        ) {
          const tx = (args[0] as number) || 0;
          const ty = (args[1] as number) || 0;
          if (fn === pdfjs.OPS.setLeadingMoveText) cur.leading = -ty;
          tlm = mulMat(tlm, [1, 0, 0, 1, tx, ty]);
          tm = [...tlm];
        } else if (fn === pdfjs.OPS.nextLine && inText) {
          tlm = mulMat(tlm, [1, 0, 0, 1, 0, -cur.leading]);
          tm = [...tlm];
        } else if (
          inText &&
          (fn === pdfjs.OPS.showText ||
            fn === pdfjs.OPS.showSpacedText ||
            fn === pdfjs.OPS.nextLineShowText ||
            fn === pdfjs.OPS.nextLineSetSpacingShowText)
        ) {
          if (fn === pdfjs.OPS.nextLineShowText || fn === pdfjs.OPS.nextLineSetSpacingShowText) {
            tlm = mulMat(tlm, [1, 0, 0, 1, 0, -cur.leading]);
            tm = [...tlm];
          }
          // Skip invisible text (rendering mode 3 or 7 or zero alpha)
          if (cur.trm !== 3 && cur.trm !== 7 && cur.fillAlpha > 0.01) {
            const glyphArgs = (
              fn === pdfjs.OPS.nextLineSetSpacingShowText ? args[2] : args[0]
            ) as unknown[];
            const worldStart = mulMat(cur.ctm, tm);
            let localAdvance = 0;
            if (Array.isArray(glyphArgs)) {
              for (const g of glyphArgs) {
                if (typeof g === "number") {
                  localAdvance -= (g / 1000) * cur.fontSize * cur.hScale;
                } else if (g && typeof g === "object" && "width" in g) {
                  const gw = (g as { width?: number; isSpace?: boolean }).width ?? 500;
                  const adv =
                    ((gw / 1000) * cur.fontSize +
                      cur.charSpacing +
                      ((g as { isSpace?: boolean }).isSpace ? cur.wordSpacing : 0)) *
                    cur.hScale;
                  localAdvance += adv;
                }
              }
            }
            tm = mulMat(tm, [1, 0, 0, 1, localAdvance, 0]);
            const worldEnd = mulMat(cur.ctm, tm);
            const synBold = cur.trm === 2 || cur.trm === 6;
            const rawColor = cur.fillColor;
            distinctTextColors.add(rawColor);
            if (synBold) anySyntheticBold = true;
            glyphSamples.push({
              x0: Math.min(worldStart[4], worldEnd[4]),
              x1: Math.max(worldStart[4], worldEnd[4]) + 0.5,
              y: worldStart[5],
              color: rawColor,
              synBold,
            });
          }
        } else if (
          fn === pdfjs.OPS.paintImageXObject ||
          fn === pdfjs.OPS.paintInlineImageXObject ||
          fn === pdfjs.OPS.paintImageMaskXObject
        ) {
          try {
            const imgObj = getImgObject(args[0]);
            recordImageAtCtm(
              imgObj,
              cur.ctm,
              fn === pdfjs.OPS.paintImageMaskXObject ? cur.fillColor : undefined
            );
          } catch {
            /* skip unresolved image safely */
          }
        } else if (fn === pdfjs.OPS.paintImageXObjectRepeat && args.length >= 4) {
          try {
            const imgObj = getImgObject(args[0]);
            const sx = (args[1] as number) || 1;
            const sy = (args[2] as number) || 1;
            const pos = (args[3] as number[]) || [];
            for (let pi = 0; pi + 1 < pos.length; pi += 2) {
              const repCtm = mulMat(cur.ctm, [sx, 0, 0, sy, pos[pi], pos[pi + 1]]);
              recordImageAtCtm(imgObj, repCtm);
            }
          } catch {
            /* optional */
          }
        }
      }
    } catch {
      /* operator pass is best-effort */
    }

    totalEmbeddedImages += placedImages.length;

    /* ── 2. Font Metadata + Binary OpenType OS/2 Weight & Style Resolution ── */
    const tc = await page.getTextContent({ includeMarkedContent: true });
    const fontMeta = new Map<string, FontMeta>();

    const resolveFont = (fontName: string): FontMeta => {
      const cached = fontMeta.get(fontName);
      if (cached) return cached;

      let realName = fontName;
      let flagBold = false;
      let flagItalic = false;
      let weight = 400;
      let generic = "sans-serif";

      try {
        const f = page.commonObjs.get(fontName) as
          | {
              name?: string;
              fallbackName?: string;
              bold?: boolean;
              italic?: boolean;
              black?: boolean;
              isSerifFont?: boolean;
              isMonospace?: boolean;
              cssFontInfo?: { fontWeight?: string | number; italicAngle?: number | string; fontFamily?: string } | null;
              data?: Uint8Array;
            }
          | undefined;

        if (f?.name) realName = f.name;
        else if (f?.cssFontInfo?.fontFamily) realName = f.cssFontInfo.fontFamily;
        else if (f?.fallbackName) realName = f.fallbackName;

        if (f?.black) {
          flagBold = true;
          weight = 900;
        } else if (f?.bold) {
          flagBold = true;
          weight = 700;
        }
        if (f?.italic) flagItalic = true;

        if (f?.cssFontInfo?.fontWeight) {
          const cw = Number(f.cssFontInfo.fontWeight);
          if (!Number.isNaN(cw) && cw >= 100 && cw <= 950) {
            weight = cw;
            if (cw >= 600) flagBold = true;
          } else if (String(f.cssFontInfo.fontWeight).toLowerCase() === "bold") {
            flagBold = true;
            weight = 700;
          }
        }
        if (f?.cssFontInfo?.italicAngle && Number(f.cssFontInfo.italicAngle) !== 0) {
          flagItalic = true;
        }

        if (f?.isMonospace) generic = "monospace";
        else if (f?.isSerifFont) generic = "serif";

        // Inspect embedded OpenType/TrueType binary font tables (OS/2, head, post, name)
        const sfnt = inspectSfntFont(f?.data);
        if (sfnt.weightClass) {
          weight = Math.max(weight, sfnt.weightClass);
        }
        if (sfnt.bold) {
          flagBold = true;
          if (weight < 600) weight = 700;
        }
        if (sfnt.italic) flagItalic = true;
        if (
          sfnt.familyName &&
          (/^g_d\d/.test(realName) || /^(TT|F|C\d_)\d+$/i.test(realName))
        ) {
          realName = sfnt.familyName;
        }
      } catch {
        /* fallback */
      }

      const style = (tc.styles as Record<string, { fontFamily?: string }>)[fontName];
      if (style?.fontFamily === "serif" || style?.fontFamily === "monospace") {
        generic = style.fontFamily;
      }

      const cleanName = realName.replace(/^[A-Z]{6}\+/, "").trim();
      if (/extrabold|ultrabold|heavy|black/i.test(cleanName)) {
        flagBold = true;
        weight = Math.max(weight, 800);
      } else if (/semibold|demibold|demi/i.test(cleanName)) {
        flagBold = true;
        weight = Math.max(weight, 600);
      } else if (/bold|(^|[-,_ ])bd($|[-,_ ])/i.test(cleanName)) {
        flagBold = true;
        weight = Math.max(weight, 700);
      } else if (/medium/i.test(cleanName) && weight === 400) {
        weight = 500;
      }
      if (/italic|oblique|slanted|(^|[-,_ ])it($|[-,_ ])/i.test(cleanName)) {
        flagItalic = true;
      }

      const meta: FontMeta = {
        name: cleanName,
        weight,
        bold: flagBold,
        italic: flagItalic,
        generic,
      };
      fontMeta.set(fontName, meta);
      if (meta.name && !/^g_d\d/.test(meta.name)) fontSet.add(meta.name);
      return meta;
    };

    const hasRichDecorations =
      distinctTextColors.size > 1 ||
      anySyntheticBold ||
      filledRects.length > 0 ||
      drawnLines.length > 0 ||
      linkBoxes.length > 0;

    const singlePageTextColor = (() => {
      if (distinctTextColors.size === 1) {
        const c = [...distinctTextColors][0];
        return c === "#ffffff" ? "#000000" : c;
      }
      return "#000000";
    })();

    /** Query exact inline styling at a horizontal slice `[cx0, cx1]` on baseline `y` with font size `fs`. */
    const resolveSliceStyle = (
      cx0: number,
      cx1: number,
      y: number,
      fs: number
    ): {
      color: string;
      bg?: string;
      synBold: boolean;
      u: boolean;
      s: boolean;
      href?: string;
    } => {
      const midX = (cx0 + cx1) / 2;

      // 1. Highlight / badge background rectangle behind this slice
      let bg: string | undefined;
      for (const r of filledRects) {
        const h = r.y1 - r.y0;
        if (
          midX >= r.x0 - 1 &&
          midX <= r.x1 + 1 &&
          y >= r.y0 - fs * 0.45 &&
          y + fs * 0.65 <= r.y1 + fs * 0.45 &&
          h <= fs * 3.2
        ) {
          bg = r.color;
        }
      }

      // 2. Glyph fill color & synthetic bold
      let rawColor = singlePageTextColor;
      let synBold = false;
      if (distinctTextColors.size > 1 || anySyntheticBold || bg) {
        let bestDist = Infinity;
        for (const gs of glyphSamples) {
          if (Math.abs(gs.y - y) > Math.max(2.5, fs * 0.45)) continue;
          const d =
            midX >= gs.x0 && midX <= gs.x1
              ? 0
              : Math.min(Math.abs(midX - gs.x0), Math.abs(midX - gs.x1));
          if (d < bestDist) {
            bestDist = d;
            rawColor = gs.color;
            synBold = gs.synBold;
            if (d === 0) break;
          }
        }
      }
      // Keep white text when drawn on a non-white badge/highlight; otherwise prevent invisible white-on-white
      const color = rawColor === "#ffffff" && !bg ? "#000000" : rawColor;

      // 3. Underline & Strikethrough bars drawn across this slice
      let u = false;
      let s = false;
      for (const ln of drawnLines) {
        if (midX < ln.x0 - 1.5 || midX > ln.x1 + 1.5) continue;
        if (ln.midY >= y - fs * 0.36 && ln.midY <= y + fs * 0.1) {
          u = true;
          ln.consumed = true;
        } else if (ln.midY >= y + fs * 0.16 && ln.midY <= y + fs * 0.55) {
          s = true;
          ln.consumed = true;
        }
      }

      // 4. Hyperlink annotation box
      let href: string | undefined;
      for (const lb of linkBoxes) {
        if (
          midX >= lb.x0 - 1 &&
          midX <= lb.x1 + 1 &&
          y + fs * 0.35 >= lb.y0 - 2 &&
          y <= lb.y1 + 2
        ) {
          href = lb.url;
          break;
        }
      }

      return { color, bg, synBold, u, s, href };
    };

    /** Convert one `tc.item` into 1 or more `RawRun`s (splitting mid-item if color/highlight/underline/link changes). */
    const expandItemToRuns = (item: {
      str: string;
      transform: number[];
      width: number;
      height: number;
      fontName: string;
    }): RawRun[] => {
      const fm = resolveFont(item.fontName);
      let fs = Math.hypot(item.transform[2], item.transform[3]);
      if (!fs || !isFinite(fs)) fs = Math.abs(item.transform[0]) || item.height;
      if (!fs || !isFinite(fs)) fs = 10;
      fs = round2(fs);

      const x = round2(item.transform[4]);
      const y = round2(item.transform[5]);
      const w = round2(item.width);

      // Detect synthetic italic via text matrix horizontal skew
      const skewItalic =
        Math.abs(item.transform[2]) > Math.abs(item.transform[3]) * 0.12 &&
        Math.abs(item.transform[1]) < Math.abs(item.transform[0]) * 0.08;

      if (item.str.trim().length > 0) {
        minBodyX = Math.min(minBodyX, x);
        maxBodyRightX = Math.max(maxBodyRightX, x + item.width);
      }

      const ff = cssFontStack(fm.name, fm.generic);
      const fnClean = /^g_d\d/.test(fm.name) ? fm.generic : fm.name;

      if (!hasRichDecorations || item.str.length <= 1 || w <= 0) {
        const st = hasRichDecorations
          ? resolveSliceStyle(x, x + Math.max(1, w), y, fs)
          : { color: singlePageTextColor, synBold: false, u: false, s: false };
        const isBold = fm.bold || st.synBold;
        return [
          {
            t: item.str,
            x,
            y,
            w,
            fs,
            fw: isBold ? Math.max(700, fm.weight) : fm.weight,
            ff,
            fn: fnClean,
            b: isBold,
            i: fm.italic || skewItalic,
            u: st.u || undefined,
            s: st.s || undefined,
            c: st.color,
            bg: st.bg,
            href: st.href,
          },
        ];
      }

      // Check if any decoration boundary falls strictly inside [x, x + w] on this Y band
      const yBandTol = Math.max(3, fs * 0.55);
      let mightVaryInside = false;
      for (const gs of glyphSamples) {
        if (
          Math.abs(gs.y - y) <= yBandTol &&
          ((gs.x0 > x + 1 && gs.x0 < x + w - 1) || (gs.x1 > x + 1 && gs.x1 < x + w - 1))
        ) {
          mightVaryInside = true;
          break;
        }
      }
      if (!mightVaryInside) {
        for (const r of filledRects) {
          if (y >= r.y0 - fs * 0.5 && y <= r.y1 + fs * 0.5) {
            if ((r.x0 > x + 1 && r.x0 < x + w - 1) || (r.x1 > x + 1 && r.x1 < x + w - 1)) {
              mightVaryInside = true;
              break;
            }
          }
        }
      }
      if (!mightVaryInside) {
        for (const ln of drawnLines) {
          if (Math.abs(ln.midY - y) <= fs * 0.6) {
            if ((ln.x0 > x + 1 && ln.x0 < x + w - 1) || (ln.x1 > x + 1 && ln.x1 < x + w - 1)) {
              mightVaryInside = true;
              break;
            }
          }
        }
      }
      if (!mightVaryInside) {
        for (const lb of linkBoxes) {
          if (y >= lb.y0 - 3 && y <= lb.y1 + 3) {
            if ((lb.x0 > x + 1 && lb.x0 < x + w - 1) || (lb.x1 > x + 1 && lb.x1 < x + w - 1)) {
              mightVaryInside = true;
              break;
            }
          }
        }
      }

      if (!mightVaryInside) {
        const st = resolveSliceStyle(x, x + w, y, fs);
        const isBold = fm.bold || st.synBold;
        return [
          {
            t: item.str,
            x,
            y,
            w,
            fs,
            fw: isBold ? Math.max(700, fm.weight) : fm.weight,
            ff,
            fn: fnClean,
            b: isBold,
            i: fm.italic || skewItalic,
            u: st.u || undefined,
            s: st.s || undefined,
            c: st.color,
            bg: st.bg,
            href: st.href,
          },
        ];
      }

      // Per-character slice grouping when colors/highlights/underlines/links change mid-item
      const chars = Array.from(item.str);
      const charW = w / chars.length;
      const subRuns: RawRun[] = [];
      let curSub: RawRun | null = null;

      for (let ci = 0; ci < chars.length; ci++) {
        const cx0 = x + ci * charW;
        const cx1 = cx0 + charW;
        // Spaces inherit adjacent style unless covered by continuous highlight/underline
        const st = resolveSliceStyle(cx0, cx1, y, fs);
        const isBold = fm.bold || st.synBold;
        const fw = isBold ? Math.max(700, fm.weight) : fm.weight;
        const isItalic = fm.italic || skewItalic;

        if (
          curSub &&
          curSub.b === isBold &&
          curSub.fw === fw &&
          curSub.i === isItalic &&
          Boolean(curSub.u) === st.u &&
          Boolean(curSub.s) === st.s &&
          (chars[ci] === " " || curSub.c === st.color) &&
          (curSub.bg || "") === (st.bg || "") &&
          (curSub.href || "") === (st.href || "")
        ) {
          curSub.t += chars[ci];
          curSub.w = round2(cx1 - curSub.x);
        } else {
          if (curSub) subRuns.push(curSub);
          curSub = {
            t: chars[ci],
            x: round2(cx0),
            y,
            w: round2(charW),
            fs,
            fw,
            ff,
            fn: fnClean,
            b: isBold,
            i: isItalic,
            u: st.u || undefined,
            s: st.s || undefined,
            c: st.color,
            bg: st.bg,
            href: st.href,
          };
        }
      }
      if (curSub) subRuns.push(curSub);
      return subRuns;
    };

    /* ── 3. Parse Tagged PDF Blocks + Flat Runs ── */
    interface TaggedDraft {
      tag: string;
      runs: RawRun[];
      hadZeroEol: boolean;
      topY: number;
    }
    const taggedDrafts: TaggedDraft[] = [];
    const tagStack: Array<{ tag: string; draftIdx: number | null }> = [];
    let activeDraftIdx: number | null = null;
    const flatRuns: RawRun[] = [];
    let sawBlockTag = false;

    for (const raw of tc.items as Array<Record<string, unknown>>) {
      if (raw.type === "beginMarkedContentProps" || raw.type === "beginMarkedContent") {
        const tag = typeof raw.tag === "string" ? raw.tag : "";
        let openedIdx: number | null = null;
        if (activeDraftIdx === null && BLOCK_TAGS.has(tag)) {
          sawBlockTag = true;
          openedIdx = taggedDrafts.length;
          taggedDrafts.push({ tag, runs: [], hadZeroEol: false, topY: -Infinity });
          activeDraftIdx = openedIdx;
        }
        tagStack.push({ tag, draftIdx: openedIdx });
      } else if (raw.type === "endMarkedContent") {
        const popped = tagStack.pop();
        if (popped && popped.draftIdx !== null && popped.draftIdx === activeDraftIdx) {
          activeDraftIdx = null;
        }
      } else if (typeof raw.str === "string") {
        const item = raw as {
          str: string;
          transform: number[];
          width: number;
          height: number;
          fontName: string;
          hasEOL?: boolean;
        };
        if (item.str.length === 0) {
          if (
            item.hasEOL &&
            activeDraftIdx !== null &&
            taggedDrafts[activeDraftIdx].runs.length === 0
          ) {
            taggedDrafts[activeDraftIdx].hadZeroEol = true;
          }
          continue;
        }
        const expanded = expandItemToRuns(item);
        flatRuns.push(...expanded);
        if (activeDraftIdx !== null) {
          const d = taggedDrafts[activeDraftIdx];
          d.runs.push(...expanded);
          for (const er of expanded) d.topY = Math.max(d.topY, er.y);
        }
      }
    }

    // Attach small inline stickers/icons (height <= 28pt) directly onto matching text lines!
    for (const img of placedImages) {
      if (img.heightPt > 28 || img.widthPt > 90) continue;
      const imgMidY = (img.y0 + img.y1) / 2;
      const inlineRun: RawRun = {
        t: "",
        x: img.x0,
        y: img.y0,
        w: img.widthPt,
        fs: img.heightPt,
        fw: 400,
        ff: "Arial, sans-serif",
        fn: "Image",
        b: false,
        i: false,
        c: "#000000",
        img: {
          dataUrl: img.dataUrl,
          widthPt: img.widthPt,
          heightPt: img.heightPt,
        },
      };

      if (sawBlockTag && taggedDrafts.length > 0) {
        for (const d of taggedDrafts) {
          if (
            d.runs.some(
              (r) => !r.img && imgMidY >= r.y - 4 && imgMidY <= r.y + r.fs + 6
            )
          ) {
            // Match exact baseline y of that line so groupIntoVisualLines keeps them together
            const nearest = d.runs.find(
              (r) => !r.img && imgMidY >= r.y - 4 && imgMidY <= r.y + r.fs + 6
            )!;
            inlineRun.y = nearest.y;
            inlineRun.fs = nearest.fs;
            d.runs.push(inlineRun);
            img.consumedInline = true;
            break;
          }
        }
      } else {
        const nearest = flatRuns.find(
          (r) => !r.img && imgMidY >= r.y - 4 && imgMidY <= r.y + r.fs + 6
        );
        if (nearest) {
          inlineRun.y = nearest.y;
          inlineRun.fs = nearest.fs;
          flatRuns.push(inlineRun);
          img.consumedInline = true;
        }
      }
    }

    const pageLeftMargin = isFinite(minBodyX) ? minBodyX : 72;
    const pageRightMargin =
      maxBodyRightX > pageLeftMargin + 100 ? maxBodyRightX : viewport.width - 72;

    const pageBlocks: Array<{
      y: number;
      block: DocBlock;
      lastLineEndX?: number;
      hadZeroEol?: boolean;
      fs?: number;
    }> = [];

    // Emit standalone / block images
    for (const img of placedImages) {
      if (img.consumedInline) continue;
      const mid = (img.x0 + img.x1) / 2;
      const align: "left" | "center" | "right" =
        Math.abs(mid - viewport.width / 2) < 28
          ? "center"
          : img.x0 > viewport.width * 0.55
            ? "right"
            : "left";
      pageBlocks.push({
        y: img.y1,
        block: {
          kind: "image",
          dataUrl: img.dataUrl,
          widthPt: img.widthPt,
          heightPt: img.heightPt,
          align,
          spaceBeforePt: 4,
        },
      });
    }

    /** Check if an entire paragraph sits inside a wide colored banner box. */
    const detectParagraphBannerBg = (vLines: VisualLine[]): string | undefined => {
      if (vLines.length === 0 || filledRects.length === 0) return undefined;
      const topY = vLines[0].y + vLines[0].maxFs;
      const botY = vLines[vLines.length - 1].y;
      for (const r of filledRects) {
        const rw = r.x1 - r.x0;
        const rh = r.y1 - r.y0;
        if (
          rw >= (pageRightMargin - pageLeftMargin) * 0.65 &&
          rh >= topY - botY - 4 &&
          rh <= (topY - botY + vLines[0].maxFs * 3.5) &&
          r.y0 <= botY + 4 &&
          r.y1 >= topY - 6
        ) {
          return r.color;
        }
      }
      return undefined;
    };

    if (sawBlockTag && taggedDrafts.length > 0) {
      /* ── Mode A: Exact Tagged PDF Block Reconstruction ── */
      let lastFontRef: { ff: string; fn: string; fs: number } = {
        ff: "Verdana, sans-serif",
        fn: "Verdana",
        fs: 9,
      };
      let lastKnownY = viewport.height - 72;

      for (const d of taggedDrafts) {
        if (
          d.runs.length === 0 ||
          d.runs.every((r) => !r.img && r.t.trim().length === 0)
        ) {
          lastKnownY -= lastFontRef.fs * 1.38;
          pageBlocks.push({
            y: lastKnownY,
            block: {
              kind: "paragraph",
              tag: "p",
              align: "left",
              lineHeight: 1.38,
              indentPt: 0,
              spaceBeforePt: 0,
              blank: true,
              spans: [
                {
                  t: "",
                  ff: lastFontRef.ff,
                  fn: lastFontRef.fn,
                  fs: lastFontRef.fs,
                  fw: 400,
                  b: false,
                  i: false,
                  c: "#000000",
                },
              ],
            },
          });
          continue;
        }

        const vLines = groupIntoVisualLines(d.runs);
        if (vLines.length === 0) continue;
        lastKnownY = vLines[vLines.length - 1].y;

        const blockSpans: DocSpan[] = [];
        let lineHeight = 1.38;
        if (vLines.length >= 2) {
          const dy = vLines[0].y - vLines[1].y;
          const ratio = dy / Math.max(8, vLines[0].maxFs);
          if (ratio >= 1.05 && ratio <= 2.2) lineHeight = round2(ratio);
        }

        for (let li = 0; li < vLines.length; li++) {
          const ls = lineRunsToSpans(vLines[li].runs);
          if (ls.length === 0) continue;
          if (blockSpans.length > 0) {
            const prevSpan = blockSpans[blockSpans.length - 1];
            if (
              !prevSpan.img &&
              !ls[0].img &&
              !/\s$/.test(prevSpan.t) &&
              !/^\s/.test(ls[0].t)
            ) {
              ls[0] = { ...ls[0], t: " " + ls[0].t };
            }
          }
          for (const sp of ls) appendSpan(blockSpans, sp);
        }

        if (blockSpans.length === 0) continue;
        const firstTextSp = blockSpans.find((s) => !s.img) ?? blockSpans[0];
        lastFontRef = {
          ff: firstTextSp.ff,
          fn: firstTextSp.fn,
          fs: firstTextSp.fs,
        };

        const align = detectAlignment(
          vLines,
          viewport.width,
          pageLeftMargin,
          pageRightMargin
        );
        const indentPt =
          align === "left"
            ? Math.max(0, round2(vLines[0].startX - pageLeftMargin))
            : 0;
        const bannerBg = detectParagraphBannerBg(vLines);
        if (bannerBg) {
          for (const sp of blockSpans) {
            if (sp.bg === bannerBg) sp.bg = undefined;
          }
        }

        pageBlocks.push({
          y: vLines[0].y,
          lastLineEndX: vLines[vLines.length - 1].endX,
          hadZeroEol: d.hadZeroEol,
          fs: firstTextSp.fs,
          block: {
            kind: "paragraph",
            tag: mapTag(d.tag),
            align,
            lineHeight,
            indentPt: indentPt < 4 ? 0 : indentPt,
            spaceBeforePt: 0,
            bgColor: bannerBg,
            spans: blockSpans,
          },
        });
      }
    } else {
      /* ── Mode B: Coordinate-Based Line, Paragraph & Table Reconstruction ── */
      const vLines = groupIntoVisualLines(flatRuns);
      let prevLine: VisualLine | null = null;
      let currentPara: {
        y: number;
        lines: VisualLine[];
        spans: DocSpan[];
        lineHeight: number;
      } | null = null;

      const flushPara = () => {
        if (!currentPara || currentPara.spans.length === 0) {
          currentPara = null;
          return;
        }
        const align = detectAlignment(
          currentPara.lines,
          viewport.width,
          pageLeftMargin,
          pageRightMargin
        );
        const indentPt =
          align === "left"
            ? Math.max(0, round2(currentPara.lines[0].startX - pageLeftMargin))
            : 0;
        const maxFs = currentPara.lines[0].maxFs;
        const bannerBg = detectParagraphBannerBg(currentPara.lines);
        if (bannerBg) {
          for (const sp of currentPara.spans) {
            if (sp.bg === bannerBg) sp.bg = undefined;
          }
        }
        pageBlocks.push({
          y: currentPara.y,
          lastLineEndX: currentPara.lines[currentPara.lines.length - 1].endX,
          fs: maxFs,
          block: {
            kind: "paragraph",
            tag: maxFs >= 17 ? "h1" : maxFs >= 13.5 ? "h2" : "p",
            align,
            lineHeight: currentPara.lineHeight,
            indentPt: indentPt < 4 ? 0 : indentPt,
            spaceBeforePt: 0,
            bgColor: bannerBg,
            spans: currentPara.spans,
          },
        });
        currentPara = null;
      };

      for (const ln of vLines) {
        const colClusters: RawRun[][] = [];
        for (const r of ln.runs) {
          if (!r.img && r.t.trim().length === 0 && colClusters.length === 0) continue;
          const curCluster = colClusters[colClusters.length - 1];
          if (!curCluster) {
            colClusters.push([r]);
          } else {
            const prevR = curCluster[curCluster.length - 1];
            const gap = r.x - (prevR.x + prevR.w);
            if (gap > Math.max(28, Math.min(prevR.fs, r.fs) * 3.0)) {
              colClusters.push([r]);
            } else {
              curCluster.push(r);
            }
          }
        }

        if (prevLine) {
          const dy = prevLine.y - ln.y;
          const unit = Math.max(10, prevLine.maxFs * 1.4);
          if (dy > prevLine.maxFs * 1.8) {
            flushPara();
            const blanks = Math.min(4, Math.max(1, Math.round(dy / unit) - 1));
            const refRun = prevLine.runs[0];
            for (let b = 0; b < blanks; b++) {
              pageBlocks.push({
                y: prevLine.y - (b + 1) * 0.1,
                block: {
                  kind: "paragraph",
                  tag: "p",
                  align: "left",
                  lineHeight: 1.38,
                  indentPt: 0,
                  spaceBeforePt: 0,
                  blank: true,
                  spans: [
                    {
                      t: "",
                      ff: refRun.ff,
                      fn: refRun.fn,
                      fs: refRun.fs,
                      fw: 400,
                      b: false,
                      i: false,
                      c: "#000000",
                    },
                  ],
                },
              });
            }
          }
        }

        if (colClusters.length >= 2) {
          flushPara();
          const colWidthsPt = colClusters.map((cl, idx) => {
            const start = cl[0].x;
            const nextStart =
              idx + 1 < colClusters.length
                ? colClusters[idx + 1][0].x
                : pageRightMargin;
            return Math.max(40, round2(nextStart - start));
          });

          const borderHit = strokedRects.find(
            (sr) => ln.y >= sr.y0 - 6 && ln.y <= sr.y1 + 6
          );

          pageBlocks.push({
            y: ln.y,
            block: {
              kind: "table",
              colWidthsPt,
              spaceBeforePt: 0,
              borderColor: borderHit?.color,
              rows: [
                {
                  cells: colClusters.map((cl) => {
                    const cxMid = (cl[0].x + cl[cl.length - 1].x + cl[cl.length - 1].w) / 2;
                    const cellBg = filledRects.find(
                      (fr) =>
                        cxMid >= fr.x0 - 2 &&
                        cxMid <= fr.x1 + 2 &&
                        ln.y >= fr.y0 - 4 &&
                        ln.y <= fr.y1 + 4 &&
                        fr.x1 - fr.x0 >= 25
                    )?.color;
                    const cellSpans = lineRunsToSpans(cl);
                    if (cellBg) {
                      for (const sp of cellSpans) {
                        if (sp.bg === cellBg) sp.bg = undefined;
                      }
                    }
                    return {
                      align: "left",
                      bgColor: cellBg,
                      spans: cellSpans,
                    };
                  }),
                },
              ],
            },
          });
          prevLine = ln;
          continue;
        }

        const lineSpans = lineRunsToSpans(ln.runs);
        if (lineSpans.length === 0) continue;

        const canMergeWithCurrent =
          currentPara !== null &&
          prevLine !== null &&
          prevLine.y - ln.y <= prevLine.maxFs * 1.75 &&
          Math.abs(prevLine.maxFs - ln.maxFs) <= 1.0 &&
          Math.abs(prevLine.startX - ln.startX) <= 12 &&
          prevLine.endX >= pageRightMargin - prevLine.maxFs * 5.5;

        if (canMergeWithCurrent && currentPara && prevLine) {
          const ratio = (prevLine.y - ln.y) / Math.max(8, prevLine.maxFs);
          if (ratio >= 1.05 && ratio <= 2.2) currentPara.lineHeight = round2(ratio);
          const prevSpan = currentPara.spans[currentPara.spans.length - 1];
          if (
            !prevSpan.img &&
            !lineSpans[0].img &&
            !/\s$/.test(prevSpan.t) &&
            !/^\s/.test(lineSpans[0].t)
          ) {
            lineSpans[0] = { ...lineSpans[0], t: " " + lineSpans[0].t };
          }
          for (const sp of lineSpans) appendSpan(currentPara.spans, sp);
          currentPara.lines.push(ln);
        } else {
          flushPara();
          currentPara = {
            y: ln.y,
            lines: [ln],
            spans: lineSpans,
            lineHeight: 1.38,
          };
        }
        prevLine = ln;
      }
      flushPara();
    }

    // Emit standalone horizontal rules (wide unconsumed lines not attached to text)
    let addedDivider = false;
    for (const ln of drawnLines) {
      if (ln.consumed) continue;
      if (ln.x1 - ln.x0 >= (pageRightMargin - pageLeftMargin) * 0.45) {
        pageBlocks.push({
          y: ln.midY,
          block: {
            kind: "divider",
            color: ln.color,
            thicknessPt: round2(Math.min(3, ln.thickness)),
            spaceBeforePt: 4,
          },
        });
        addedDivider = true;
      }
    }

    if (placedImages.some((im) => !im.consumedInline) || addedDivider) {
      pageBlocks.sort((a, b) => b.y - a.y);
    }

    // Cross-page flowing paragraph stitch
    let startIndex = 0;
    if (
      prevPageEndMeta &&
      pageBlocks.length > 0 &&
      pageBlocks[0].block.kind === "paragraph" &&
      !pageBlocks[0].block.blank
    ) {
      const firstEntry = pageBlocks[0];
      const firstPara = firstEntry.block as Extract<DocBlock, { kind: "paragraph" }>;
      const prevBlock = allBlocks[prevPageEndMeta.blockIdx];
      if (
        prevBlock &&
        prevBlock.kind === "paragraph" &&
        !prevBlock.blank &&
        prevBlock.spans.length > 0 &&
        firstPara.spans.length > 0
      ) {
        const lastPrevSpan = prevBlock.spans[prevBlock.spans.length - 1];
        const prevText = lastPrevSpan.t.trimEnd();
        const reachedMargin =
          prevPageEndMeta.lastLineEndX >= prevPageEndMeta.pageWidth - 120;
        const endedSentence = /[.!?:)\]]$/.test(prevText);
        const sameSize =
          Math.abs((firstEntry.fs ?? 9) - prevPageEndMeta.fs) <= 1.0;

        if (
          reachedMargin &&
          !endedSentence &&
          sameSize &&
          firstEntry.hadZeroEol !== true
        ) {
          const joinFirst = { ...firstPara.spans[0] };
          if (
            !lastPrevSpan.img &&
            !joinFirst.img &&
            !/\s$/.test(lastPrevSpan.t) &&
            !/^\s/.test(joinFirst.t)
          ) {
            joinFirst.t = " " + joinFirst.t;
          }
          appendSpan(prevBlock.spans, joinFirst);
          for (let si = 1; si < firstPara.spans.length; si++) {
            appendSpan(prevBlock.spans, firstPara.spans[si]);
          }
          startIndex = 1;
        }
      }
    }

    // Merge consecutive compatible 1-row tables into a multi-row table
    for (let bi = startIndex; bi < pageBlocks.length; bi++) {
      const entry = pageBlocks[bi];
      const prev = allBlocks[allBlocks.length - 1];
      if (
        entry.block.kind === "table" &&
        prev &&
        prev.kind === "table" &&
        prev.colWidthsPt.length === entry.block.colWidthsPt.length
      ) {
        if (!prev.borderColor && entry.block.borderColor) {
          prev.borderColor = entry.block.borderColor;
        }
        prev.rows.push(...entry.block.rows);
      } else {
        allBlocks.push(entry.block);
      }
    }

    const lastEntry = pageBlocks[pageBlocks.length - 1];
    if (
      lastEntry &&
      lastEntry.block.kind === "paragraph" &&
      !lastEntry.block.blank &&
      lastEntry.lastLineEndX !== undefined
    ) {
      prevPageEndMeta = {
        blockIdx: allBlocks.length - 1,
        lastLineEndX: lastEntry.lastLineEndX,
        pageWidth: viewport.width,
        fs: lastEntry.fs ?? 9,
      };
    } else {
      prevPageEndMeta = null;
    }

    page.cleanup();
  }

  const fullCount = doc.numPages;
  await loadingTask.destroy();

  const marginLeftPt = isFinite(minBodyX) ? round2(minBodyX) : 72;
  const marginRightPt =
    maxBodyRightX > marginLeftPt
      ? Math.max(36, round2(docWidthPt - maxBodyRightX))
      : 72;

  return {
    sourceUrl,
    title,
    pageCount: fullCount,
    pageWidthPt: docWidthPt,
    marginLeftPt,
    marginRightPt,
    fonts: Array.from(fontSet).sort(),
    imageCount: totalEmbeddedImages,
    blocks: allBlocks,
  };
}
