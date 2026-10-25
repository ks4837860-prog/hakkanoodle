import type { DocSpan, ExtractionPayload } from "@/lib/types";
import {
  detectPhoneNumbers,
  formatReplacementLikeOriginal,
  type Assignment,
} from "@/lib/signal";

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escTextPreservingRunsOfSpaces(s: string): string {
  const escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/ {2,}/g, (m) => " " + "&nbsp;".repeat(m.length - 1));
}

function renderSpans(spans: DocSpan[]): string {
  return spans
    .map((s) => {
      if (s.img) {
        const pxW = Math.max(6, Math.round(s.img.widthPt * 1.333));
        const pxH = Math.max(6, Math.round(s.img.heightPt * 1.333));
        const imgStyle = [
          `width:${s.img.widthPt}pt`,
          `height:${s.img.heightPt}pt`,
          `vertical-align:middle`,
          `display:inline-block`,
        ].join(";");
        return `<img src="${escAttr(s.img.dataUrl)}" width="${pxW}" height="${pxH}" style="${escAttr(imgStyle)}" alt="" />`;
      }

      const weight = s.b ? Math.max(700, s.fw || 700) : s.fw || 400;
      const decorations: string[] = [];
      if (s.u) decorations.push("underline");
      if (s.s) decorations.push("line-through");

      const styleParts = [
        `font-family:${s.ff}`,
        `font-size:${s.fs}pt`,
        `font-weight:${weight}`,
        `font-style:${s.i ? "italic" : "normal"}`,
        `color:${s.c || "#000000"}`,
        `background-color:${s.bg ? s.bg : "transparent"}`,
      ];
      if (decorations.length > 0) {
        styleParts.push(`text-decoration:${decorations.join(" ")}`);
      }

      let inner = escTextPreservingRunsOfSpaces(s.t);
      if (s.s) inner = `<s>${inner}</s>`;
      if (s.u) inner = `<u>${inner}</u>`;
      if (s.i) inner = `<i>${inner}</i>`;
      if (s.b) inner = `<b>${inner}</b>`;

      const spanHtml = `<span style="${escAttr(styleParts.join(";"))}">${inner}</span>`;
      if (s.href) {
        const aStyle = [
          `color:${s.c || "#1155cc"}`,
          `text-decoration:${s.u ? "underline" : "none"}`,
        ].join(";");
        return `<a href="${escAttr(s.href)}" target="_blank" rel="noreferrer" style="${escAttr(aStyle)}">${spanHtml}</a>`;
      }
      return spanHtml;
    })
    .join("");
}

/**
 * Convert an extracted PDF payload into clean, self-contained HTML that:
 * 1) Renders identically to the real PDF inside the console viewport, AND
 * 2) Pastes into Google Docs / Word with 100% matching fonts, sizes, bold/italic,
 *    underline/strikethrough, text & highlight colors, links, tables, and images/stickers.
 */
export function payloadToDocHtml(payload: ExtractionPayload): string {
  const parts: string[] = [];

  for (const b of payload.blocks) {
    if (b.kind === "paragraph") {
      if (b.blank) {
        const ref = b.spans[0] ?? {
          ff: "Arial, sans-serif",
          fs: 10,
        };
        const pStyle = `margin:0pt;padding:0pt;line-height:${b.lineHeight};`;
        const sStyle = `font-family:${ref.ff};font-size:${ref.fs}pt;color:#000000;background-color:transparent;`;
        parts.push(
          `<p data-blank="1" style="${escAttr(pStyle)}"><span style="${escAttr(sStyle)}">&nbsp;</span></p>`
        );
        continue;
      }

      const pStyles = [
        `margin-top:${b.spaceBeforePt}pt`,
        `margin-bottom:0pt`,
        `line-height:${b.lineHeight}`,
        `text-align:${b.align}`,
      ];
      if (b.indentPt > 0) pStyles.push(`margin-left:${b.indentPt}pt`);
      if (b.bgColor) {
        pStyles.push(`background-color:${b.bgColor}`);
        pStyles.push(`padding:3pt 6pt`);
      }

      parts.push(
        `<p style="${escAttr(pStyles.join(";"))}">${renderSpans(b.spans)}</p>`
      );
    } else if (b.kind === "table") {
      const totalW = b.colWidthsPt.reduce((acc, w) => acc + w, 0) || 450;
      const cellBorder = b.borderColor ? `0.75pt solid ${b.borderColor}` : "none";
      const rowsHtml = b.rows
        .map((row) => {
          const tds = row.cells
            .map((cell, ci) => {
              const wPt = b.colWidthsPt[ci] ?? Math.round(totalW / row.cells.length);
              const pct = Math.round((wPt / totalW) * 1000) / 10;
              const tdStyles = [
                `width:${pct}%`,
                `padding:${b.borderColor || cell.bgColor ? "3pt 6pt" : "1.5pt 6pt 1.5pt 0pt"}`,
                `vertical-align:top`,
                `text-align:${cell.align}`,
                `border:${cellBorder}`,
              ];
              if (cell.bgColor) {
                tdStyles.push(`background-color:${cell.bgColor}`);
              }
              return `<td style="${escAttr(tdStyles.join(";"))}">${renderSpans(cell.spans)}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");

      parts.push(
        `<table style="border-collapse:collapse;border:${cellBorder};width:100%;margin-top:${b.spaceBeforePt}pt;margin-bottom:0pt;"><tbody>${rowsHtml}</tbody></table>`
      );
    } else if (b.kind === "image") {
      const pxW = Math.max(8, Math.round(b.widthPt * 1.333));
      const pxH = Math.max(8, Math.round(b.heightPt * 1.333));
      const pStyle = `margin:${b.spaceBeforePt}pt 0pt 0pt 0pt;text-align:${b.align};`;
      const imgStyle = `width:${b.widthPt}pt;height:${b.heightPt}pt;max-width:100%;height:auto;vertical-align:middle;display:inline-block;`;
      parts.push(
        `<p style="${escAttr(pStyle)}"><img src="${escAttr(b.dataUrl)}" width="${pxW}" height="${pxH}" style="${escAttr(imgStyle)}" alt="" /></p>`
      );
    } else if (b.kind === "divider") {
      const hrStyle = `border:none;border-top:${b.thicknessPt}pt solid ${b.color};margin:${b.spaceBeforePt}pt 0pt;`;
      parts.push(`<hr style="${escAttr(hrStyle)}" />`);
    }
  }

  return parts.join("");
}

/** Convert plain text into clean HTML paragraphs when no rich PDF is active. */
export function plainTextToDocHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) {
        return `<p data-blank="1" style="margin:0pt;line-height:1.45;"><span style="font-family:Arial, sans-serif;font-size:11pt;color:#000000;">&nbsp;</span></p>`;
      }
      return `<p style="margin:0pt;line-height:1.45;"><span style="font-family:Arial, sans-serif;font-size:11pt;color:#000000;">${escTextPreservingRunsOfSpaces(line)}</span></p>`;
    })
    .join("");
}

export function payloadBlockCount(payload: ExtractionPayload): number {
  let count = 0;
  for (const b of payload.blocks) {
    if (b.kind === "paragraph") {
      if (!b.blank) count += b.spans.length;
    } else if (b.kind === "table") {
      for (const r of b.rows) for (const c of r.cells) count += c.spans.length;
    } else if (b.kind === "image" || b.kind === "divider") {
      count += 1;
    }
  }
  return count;
}

const LEAF_BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote";

function getLeafBlocks(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(LEAF_BLOCK_SELECTOR)
  ).filter((el) => !el.querySelector(LEAF_BLOCK_SELECTOR));

  if (candidates.length > 0) return candidates;
  const divs = Array.from(root.querySelectorAll<HTMLElement>("div")).filter(
    (el) => !el.querySelector("div, " + LEAF_BLOCK_SELECTOR)
  );
  return divs.length > 0 ? divs : [root];
}

interface TextSeg {
  node: Text | null;
  start: number;
  end: number;
}

function collectBlockSegments(block: HTMLElement): {
  fullText: string;
  segments: TextSeg[];
} {
  const segments: TextSeg[] = [];
  let fullText = "";

  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const tNode = n as Text;
      const val = tNode.nodeValue ?? "";
      if (val.length > 0) {
        const start = fullText.length;
        fullText += val;
        segments.push({ node: tNode, start, end: fullText.length });
      }
      return;
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.tagName === "BR" || el.tagName === "IMG") {
        const start = fullText.length;
        fullText += "\n";
        segments.push({ node: null, start, end: fullText.length });
        return;
      }
      for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
    }
  };

  if (block.getAttribute("data-blank") === "1") {
    return { fullText: "", segments: [] };
  }
  walk(block);
  return { fullText, segments };
}

/** Extract clean plain text from rich HTML (preserving paragraph & blank lines). */
export function extractPlainTextFromHtml(html: string): string {
  if (!html || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = getLeafBlocks(doc.body);
  return blocks
    .map((b) => {
      if (b.getAttribute("data-blank") === "1") return "";
      const { fullText } = collectBlockSegments(b);
      return fullText.replace(/\u00a0/g, " ");
    })
    .join("\n");
}

export interface RichRealignResult {
  html: string;
  plainText: string;
  modifiedCount: number;
  assignments: Assignment[];
  elapsedMs: number;
}

/**
 * Surgically realign all phone/signal numbers inside rich HTML while keeping
 * EVERY font, font-size, bold/italic, underline/strikethrough, text color,
 * highlight background, link, spacer line, table, and image/sticker 100% untouched.
 */
export function realignRichHtml(
  html: string,
  replacementPool: string[],
  preserveFormat: boolean
): RichRealignResult {
  const t0 = performance.now();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = getLeafBlocks(doc.body);

  const uniqueRawSeen: string[] = [];
  const rawToReplacementMap = new Map<string, string>();
  let modifiedCount = 0;

  for (const block of blocks) {
    const { fullText, segments } = collectBlockSegments(block);
    if (!fullText) continue;

    const detected = detectPhoneNumbers(fullText);
    if (detected.length === 0) continue;

    const validSpans: typeof detected = [];
    let lastEnd = 0;
    for (const sp of detected) {
      if (sp.start < lastEnd) continue;
      validSpans.push(sp);
      lastEnd = sp.end;

      if (!uniqueRawSeen.includes(sp.raw)) {
        uniqueRawSeen.push(sp.raw);
        const assignedIdx = uniqueRawSeen.length - 1;
        const chosen = replacementPool[assignedIdx] || replacementPool[0];
        rawToReplacementMap.set(sp.raw, chosen);
      }
    }

    for (let i = validSpans.length - 1; i >= 0; i--) {
      const sp = validSpans[i];
      const targetNum = rawToReplacementMap.get(sp.raw)!;
      const replText = preserveFormat
        ? formatReplacementLikeOriginal(sp.raw, targetNum)
        : targetNum;

      const overlapping = segments.filter(
        (seg): seg is { node: Text; start: number; end: number } =>
          seg.node !== null && seg.end > sp.start && seg.start < sp.end
      );
      if (overlapping.length === 0) continue;

      if (overlapping.length === 1) {
        const seg = overlapping[0];
        const val = seg.node.nodeValue ?? "";
        const localStart = sp.start - seg.start;
        const localEnd = sp.end - seg.start;
        seg.node.nodeValue =
          val.slice(0, localStart) + replText + val.slice(localEnd);
      } else {
        let remRepl = replText;
        for (let k = 0; k < overlapping.length; k++) {
          const seg = overlapping[k];
          const val = seg.node.nodeValue ?? "";
          const localStart = Math.max(0, sp.start - seg.start);
          const localEnd = Math.min(val.length, sp.end - seg.start);
          const consumed = val.slice(localStart, localEnd);

          if (k < overlapping.length - 1) {
            if (consumed.length > 0 && remRepl.startsWith(consumed)) {
              remRepl = remRepl.slice(consumed.length);
            } else {
              seg.node.nodeValue = val.slice(0, localStart) + val.slice(localEnd);
            }
          } else {
            seg.node.nodeValue =
              val.slice(0, localStart) + remRepl + val.slice(localEnd);
          }
        }
      }

      // If the replaced phone number was inside an <a href="tel:..."> link, update tel: href too
      const hostEl = overlapping[overlapping.length - 1].node.parentElement?.closest("a");
      if (hostEl && /^tel:/i.test(hostEl.getAttribute("href") || "")) {
        const cleanDigits = targetNum.replace(/[^\d+]/g, "");
        if (cleanDigits) hostEl.setAttribute("href", `tel:${cleanDigits}`);
      }

      modifiedCount++;
    }
  }

  const elapsedMs = performance.now() - t0;
  const outHtml = doc.body.innerHTML;
  const plainText = extractPlainTextFromHtml(outHtml);

  return {
    html: outHtml,
    plainText,
    modifiedCount,
    assignments: uniqueRawSeen.map((raw) => ({
      raw,
      replacement: rawToReplacementMap.get(raw)!,
    })),
    elapsedMs,
  };
}

/** Count detected signals across rich HTML without mutating it. */
export function scanSignalsInHtml(html: string): {
  total: number;
  unique: number;
} {
  if (!html || typeof DOMParser === "undefined") return { total: 0, unique: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = getLeafBlocks(doc.body);
  let total = 0;
  const uniq = new Set<string>();
  for (const b of blocks) {
    const { fullText } = collectBlockSegments(b);
    if (!fullText) continue;
    let lastEnd = 0;
    for (const sp of detectPhoneNumbers(fullText)) {
      if (sp.start < lastEnd) continue;
      lastEnd = sp.end;
      total++;
      uniq.add(sp.raw);
    }
  }
  return { total, unique: uniq.size };
}

/** Sanitize pasted clipboard HTML while preserving all fonts, colors, bold/italic, tables, links & images. */
export function sanitizePastedRichHtml(rawHtml: string): string {
  if (!rawHtml || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  doc
    .querySelectorAll("script, iframe, object, embed, meta, link, title, style")
    .forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (name === "href" && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

/** Wrap body HTML into a clean standalone document for Google Docs / Word clipboard paste. */
export function wrapForGoogleDocsClipboard(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background-color:#ffffff;color:#000000;">${bodyHtml}</body></html>`;
}

/**
 * Copy BOTH rich `text/html` (for Google Docs / Word / Sheets) AND `text/plain`
 * with dual-strategy support (ClipboardItem API + synchronous execCommand fallback).
 */
export async function copyRichDocumentToClipboard(
  bodyHtml: string,
  plainText: string
): Promise<"rich" | "plain"> {
  const wrappedHtml = wrapForGoogleDocsClipboard(bodyHtml);

  try {
    if (
      typeof ClipboardItem !== "undefined" &&
      navigator.clipboard &&
      "write" in navigator.clipboard
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([wrappedHtml], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return "rich";
    }
  } catch {
    /* Fall through to synchronous copy event strategy */
  }

  try {
    let copiedRich = false;
    const onCopy = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      e.clipboardData.setData("text/html", wrappedHtml);
      e.clipboardData.setData("text/plain", plainText);
      e.preventDefault();
      copiedRich = true;
    };
    document.addEventListener("copy", onCopy, true);
    const dummy = document.createElement("textarea");
    dummy.value = " ";
    dummy.setAttribute("readonly", "true");
    dummy.style.position = "fixed";
    dummy.style.top = "-9999px";
    dummy.style.opacity = "0";
    document.body.appendChild(dummy);
    dummy.select();
    const ok = document.execCommand("copy");
    dummy.remove();
    document.removeEventListener("copy", onCopy, true);
    if (ok && copiedRich) return "rich";
  } catch {
    /* Fall through to plain writeText */
  }

  await navigator.clipboard.writeText(plainText);
  return "plain";
}
