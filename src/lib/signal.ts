/* ══════════════════════════════════════════════════
   SIGNAL PARSING ENGINE — full port of the Vanguard
   coordinate realignment logic (unicode-digit aware)
   ══════════════════════════════════════════════════ */

export interface DigitHit {
  value: string;
  end: number;
  cp: number;
}

export interface PhoneSpan {
  start: number;
  end: number;
  raw: string;
  digits: string;
}

export interface Assignment {
  raw: string;
  replacement: string;
}

export interface RealignResult {
  output: string;
  modifiedCount: number;
  assignments: Assignment[];
  elapsedMs: number;
}

export function digitAt(str: string, i: number): DigitHit | null {
  const cp = str.codePointAt(i);
  if (cp === undefined) return null;
  const end = i + (cp > 0xffff ? 2 : 1);
  const ret = (v: number): DigitHit => ({ value: String(v), end, cp });
  if (cp >= 0x30 && cp <= 0x39) return ret(cp - 0x30);
  if (cp >= 0xff10 && cp <= 0xff19) return ret(cp - 0xff10);
  if (cp >= 0x0660 && cp <= 0x0669) return ret(cp - 0x0660);
  if (cp >= 0x06f0 && cp <= 0x06f9) return ret(cp - 0x06f0);
  if (cp >= 0x0966 && cp <= 0x096f) return ret(cp - 0x0966);
  const mr: Array<[number, number]> = [
    [0x1d7ce, 0x1d7d7],
    [0x1d7d8, 0x1d7e1],
    [0x1d7e2, 0x1d7eb],
    [0x1d7ec, 0x1d7f5],
    [0x1d7f6, 0x1d7ff],
  ];
  for (const [lo, hi] of mr) if (cp >= lo && cp <= hi) return ret(cp - lo);
  if (cp === 0x2070) return ret(0);
  if (cp === 0x00b9) return ret(1);
  if (cp === 0x00b2) return ret(2);
  if (cp === 0x00b3) return ret(3);
  if (cp >= 0x2074 && cp <= 0x2079) return ret(cp - 0x2070);
  if (cp >= 0x2080 && cp <= 0x2089) return ret(cp - 0x2080);
  if (cp === 0x24ea) return ret(0);
  if (cp >= 0x2460 && cp <= 0x2468) return ret(cp - 0x245f);
  return null;
}

export function nextIndex(str: string, i: number): number {
  const cp = str.codePointAt(i);
  return i + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

function formatDigitLike(ad: string, odi: DigitHit): string {
  const n = Number(ad);
  const cp = odi.cp;
  if (Number.isNaN(n)) return ad;
  if (cp >= 0x30 && cp <= 0x39) return ad;
  if (cp >= 0xff10 && cp <= 0xff19) return String.fromCharCode(0xff10 + n);
  if (cp >= 0x0660 && cp <= 0x0669) return String.fromCharCode(0x0660 + n);
  if (cp >= 0x06f0 && cp <= 0x06f9) return String.fromCharCode(0x06f0 + n);
  if (cp >= 0x0966 && cp <= 0x096f) return String.fromCharCode(0x0966 + n);
  const mr: Array<[number, number]> = [
    [0x1d7ce, 0x1d7d7],
    [0x1d7d8, 0x1d7e1],
    [0x1d7e2, 0x1d7eb],
    [0x1d7ec, 0x1d7f5],
    [0x1d7f6, 0x1d7ff],
  ];
  for (const [lo, hi] of mr)
    if (cp >= lo && cp <= hi) return String.fromCodePoint(lo + n);
  const sp = ["\u2070", "\u00B9", "\u00B2", "\u00B3", "\u2074", "\u2075", "\u2076", "\u2077", "\u2078", "\u2079"];
  if (cp === 0x2070 || cp === 0x00b9 || cp === 0x00b2 || cp === 0x00b3 || (cp >= 0x2074 && cp <= 0x2079))
    return sp[n];
  if (cp >= 0x2080 && cp <= 0x2089) return String.fromCharCode(0x2080 + n);
  if (cp === 0x24ea || (cp >= 0x2460 && cp <= 0x2468)) {
    if (n === 0) return "⓪";
    return String.fromCharCode(0x245f + n);
  }
  return ad;
}

function getAsciiDigits(str: string): string[] {
  const arr: string[] = [];
  let i = 0;
  while (i < str.length) {
    const d = digitAt(str, i);
    if (d) {
      arr.push(d.value);
      i = d.end;
    } else i = nextIndex(str, i);
  }
  return arr;
}

export function formatReplacementLikeOriginal(orig: string, repl: string): string {
  const rd = getAsciiDigits(repl);
  if (!rd.length) return repl;
  let out = "";
  let ri = 0;
  let j = 0;
  while (j < orig.length) {
    const d = digitAt(orig, j);
    if (d) {
      if (ri < rd.length) {
        out += formatDigitLike(rd[ri], d);
        ri++;
      }
      j = d.end;
      continue;
    }
    out += orig.slice(j, nextIndex(orig, j));
    j = nextIndex(orig, j);
  }
  if (ri < rd.length) out += rd.slice(ri).join("");
  return out;
}

const letterRE = /\p{L}/u;
const isLetter = (ch: string) => letterRE.test(ch);
const isHardBreak = (ch: string) => ch === "\n" || ch === "\r";
const isSpaceLike = (ch: string) =>
  ch === " " || ch === "\t" || ch === "\u00A0" || ch === "\u2009" || ch === "\u200A";
function isIgnorable(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}
const isConnector = (ch: string) => !(isHardBreak(ch) || isLetter(ch));

function hasDigitAhead(str: string, pos: number, maxSteps: number): boolean {
  let p = pos;
  let s = 0;
  while (p < str.length && s < maxSteps) {
    if (digitAt(str, p)) return true;
    const ch = str.slice(p, nextIndex(str, p));
    if (isHardBreak(ch) || isLetter(ch)) return false;
    p = nextIndex(str, p);
    s++;
  }
  return false;
}

const isStartSymbol = (ch: string) =>
  ch === "+" || ch === "＋" || ch === "(" || ch === "（" || ch === "[" ||
  ch === "{" || ch === "【" || ch === "〔";

function startsAnotherPlusNumberAhead(str: string, pos: number): boolean {
  let p = pos;
  let s = 0;
  while (p < str.length && s < 18) {
    if (digitAt(str, p)) return false;
    const ch = str.slice(p, nextIndex(str, p));
    if (isHardBreak(ch) || isLetter(ch)) return false;
    if (ch === "+" || ch === "＋") return hasDigitAhead(str, p, 12);
    if (ch === "(" || ch === "（" || ch === "[" || ch === "{") {
      let q = nextIndex(str, p);
      let ls = 0;
      while (q < str.length && ls < 6) {
        const c2 = str.slice(q, nextIndex(str, q));
        if (isSpaceLike(c2) || isIgnorable(c2)) {
          q = nextIndex(str, q);
          ls++;
          continue;
        }
        if (c2 === "+" || c2 === "＋") return hasDigitAhead(str, q, 12);
        break;
      }
    }
    p = nextIndex(str, p);
    s++;
  }
  return false;
}

function hasDoubleSpaceBeforeNextDigit(str: string, pos: number): boolean {
  let p = pos;
  let sp = 0;
  let s = 0;
  while (p < str.length && s < 18) {
    if (digitAt(str, p)) return sp >= 2;
    const ch = str.slice(p, nextIndex(str, p));
    if (isHardBreak(ch) || isLetter(ch)) return false;
    if (isSpaceLike(ch)) sp++;
    p = nextIndex(str, p);
    s++;
  }
  return false;
}

function scanPhoneSpan(str: string, start: number): PhoneSpan | null {
  let pos = start;
  let digits = "";
  let lastEnd = -1;
  while (pos < str.length) {
    const d = digitAt(str, pos);
    if (d) {
      if (digits.length >= 15) break;
      digits += d.value;
      lastEnd = d.end;
      pos = d.end;
      continue;
    }
    const ch = str.slice(pos, nextIndex(str, pos));
    if (isIgnorable(ch)) {
      pos = nextIndex(str, pos);
      continue;
    }
    if (isHardBreak(ch) || isLetter(ch)) break;
    if (isConnector(ch)) {
      if (digits.length >= 7 && startsAnotherPlusNumberAhead(str, pos)) break;
      if (digits.length >= 7 && hasDoubleSpaceBeforeNextDigit(str, pos)) break;
      if (hasDigitAhead(str, pos, 18)) {
        pos = nextIndex(str, pos);
        continue;
      }
      break;
    }
    break;
  }
  if (digits.length >= 7 && digits.length <= 15 && lastEnd > start) {
    return { start, end: lastEnd, raw: str.slice(start, lastEnd), digits };
  }
  return null;
}

export function detectPhoneNumbers(text: string): PhoneSpan[] {
  const result: PhoneSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (
      digitAt(text, i) ||
      (isStartSymbol(text.slice(i, nextIndex(text, i))) && hasDigitAhead(text, i, 14))
    ) {
      const sp = scanPhoneSpan(text, i);
      if (sp) {
        result.push(sp);
        i = sp.end;
        continue;
      }
    }
    i = nextIndex(text, i);
  }
  return result;
}

/**
 * Same core routine as the original console: each unique detected
 * coordinate is assigned the next replacement from the pool, in order.
 * Inputs are always read from separate slots — values never merge.
 */
export function executeRealignment(
  srcText: string,
  replacementPool: string[],
  preserveFormat: boolean
): RealignResult {
  const t0 = performance.now();
  const detectedSpans = detectPhoneNumbers(srcText);
  const elapsedMs = performance.now() - t0;

  const uniqueRawSeen: string[] = [];
  const rawToReplacementMap = new Map<string, string>();

  detectedSpans.forEach((span) => {
    if (!uniqueRawSeen.includes(span.raw)) {
      uniqueRawSeen.push(span.raw);
      const assignedIndex = uniqueRawSeen.length - 1;
      const chosen = replacementPool[assignedIndex] || replacementPool[0];
      rawToReplacementMap.set(span.raw, chosen);
    }
  });

  let output = "";
  let lastIndex = 0;
  let modifiedCount = 0;

  for (const span of detectedSpans) {
    if (span.start < lastIndex) continue;
    output += srcText.slice(lastIndex, span.start);
    const replacementNumber = rawToReplacementMap.get(span.raw)!;
    output += preserveFormat
      ? formatReplacementLikeOriginal(span.raw, replacementNumber)
      : replacementNumber;
    modifiedCount++;
    lastIndex = span.end;
  }
  output += srcText.slice(lastIndex);

  return {
    output,
    modifiedCount,
    assignments: uniqueRawSeen.map((raw) => ({
      raw,
      replacement: rawToReplacementMap.get(raw)!,
    })),
    elapsedMs,
  };
}