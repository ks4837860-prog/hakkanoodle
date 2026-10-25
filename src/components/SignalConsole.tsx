"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronsLeft,
  ClipboardCopy,
  Crosshair,
  ExternalLink,
  FileCheck2,
  FileDown,
  FileText,
  History,
  Link2,
  ListPlus,
  Loader2,
  Plus,
  Radio,
  RotateCcw,
  Satellite,
  ScanSearch,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { ExtractionPayload, HistoryEntry } from "@/lib/types";
import {
  detectPhoneNumbers,
  executeRealignment,
  type Assignment,
} from "@/lib/signal";
import {
  copyRichDocumentToClipboard,
  extractPlainTextFromHtml,
  payloadToDocHtml,
  plainTextToDocHtml,
  realignRichHtml,
  sanitizePastedRichHtml,
  scanSignalsInHtml,
} from "@/lib/doc-html";

const EXAMPLE_URL =
  "https://actv.avmspa.it/sites/default/files/webform/surr010.pdf";

const CATCH_STEPS = [
  "Connecting to remote PDF stream…",
  "Extracting pages, fonts, styles & symbols…",
  "Reconstructing original paragraphs & layout…",
];

interface Props {
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
}

export default function SignalConsole({ pushToast }: Props) {
  /* ── URL Content Catcher state ── */
  const [pdfUrl, setPdfUrl] = useState("");
  const [catching, setCatching] = useState(false);
  const [catchStep, setCatchStep] = useState(0);
  const [catchError, setCatchError] = useState<string | null>(null);
  const [caughtPayload, setCaughtPayload] = useState<ExtractionPayload | null>(null);
  const [caughtItemCount, setCaughtItemCount] = useState<number>(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  /* ── Source Transmission Block state (Plain OR Faithful Rich PDF Document) ── */
  const [plainSource, setPlainSource] = useState("");
  const [richSourceHtml, setRichSourceHtml] = useState<string | null>(null);
  const [richSourceNonce, setRichSourceNonce] = useState(0);
  const [activeDocMeta, setActiveDocMeta] = useState<{
    title: string;
    pageCount: number;
    fonts: string[];
  } | null>(null);
  const sourceDocRef = useRef<HTMLDivElement | null>(null);

  /* ── Coordinates & Realignment Output state ── */
  const [slots, setSlots] = useState<string[]>(["", ""]);
  const [preserveFormat, setPreserveFormat] = useState(true);
  const [outputState, setOutputState] = useState<{
    mode: "rich" | "plain";
    html: string;
    plainText: string;
  } | null>(null);
  const [stats, setStats] = useState<{ modified: number; ms: string } | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedSource, setCopiedSource] = useState(false);
  const [liveScan, setLiveScan] = useState<{ total: number; unique: number } | null>(
    null
  );

  const slotRefs = useRef<Array<HTMLInputElement | null>>([]);
  const outputCardRef = useRef<HTMLElement | null>(null);

  /* ── Load recent PDF catches archive ── */
  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/extract");
      const data = await res.json();
      setHistory(data.entries ?? []);
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!catching) return;
    setCatchStep(0);
    const iv = setInterval(
      () => setCatchStep((s) => Math.min(s + 1, CATCH_STEPS.length - 1)),
      1200
    );
    return () => clearInterval(iv);
  }, [catching]);

  /* ── Populate contentEditable only when a new pull happens (preserves user cursor edits) ── */
  useEffect(() => {
    if (richSourceHtml !== null && sourceDocRef.current) {
      sourceDocRef.current.innerHTML = richSourceHtml;
    }
  }, [richSourceNonce, richSourceHtml]);

  /* ── Live signal scan for plain mode ── */
  useEffect(() => {
    if (richSourceHtml !== null) return;
    if (!plainSource.trim()) {
      setLiveScan(null);
      return;
    }
    const t = setTimeout(() => {
      const spans = detectPhoneNumbers(plainSource);
      let lastEnd = 0;
      let total = 0;
      const uniq = new Set<string>();
      for (const sp of spans) {
        if (sp.start < lastEnd) continue;
        lastEnd = sp.end;
        total++;
        uniq.add(sp.raw);
      }
      setLiveScan({ total, unique: uniq.size });
    }, 300);
    return () => clearTimeout(t);
  }, [plainSource, richSourceHtml]);

  /* ── Pull a caught payload into the Source Transmission Block with 100% original format ── */
  const pullPayloadIntoSource = useCallback(
    (payload: ExtractionPayload) => {
      const docHtml = payloadToDocHtml(payload);
      setRichSourceHtml(docHtml);
      setRichSourceNonce((n) => n + 1);
      setActiveDocMeta({
        title: payload.title,
        pageCount: payload.pageCount,
        fonts: payload.fonts,
      });
      setOutputState(null);
      setStats(null);
      setAssignments([]);
      const scan = scanSignalsInHtml(docHtml);
      setLiveScan(scan);
      pushToast(
        "ok",
        `Pulled "${payload.title}" (${payload.pageCount} pages) with original fonts, styles & layout intact.`
      );
    },
    [pushToast]
  );

  /* ── Catch PDF from URL ── */
  const catchPdfFromUrl = useCallback(
    async (
      overrideUrl?: string,
      autoPullAfterCatch = false
    ): Promise<ExtractionPayload | null> => {
      const u = (overrideUrl ?? pdfUrl).trim();
      if (!u) {
        setCatchError("Paste a PDF URL first — e.g. " + EXAMPLE_URL);
        pushToast("err", "PDF URL is empty.");
        return null;
      }
      if (overrideUrl) setPdfUrl(overrideUrl);
      setCatching(true);
      setCatchError(null);
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: u }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data.error || "Failed to catch PDF content from URL.";
          setCatchError(msg);
          pushToast("err", msg);
          return null;
        }
        const payload = data.payload as ExtractionPayload;
        setCaughtPayload(payload);
        setCaughtItemCount(data.itemCount ?? 0);
        refreshHistory();

        if (autoPullAfterCatch) {
          pullPayloadIntoSource(payload);
        } else {
          pushToast(
            "ok",
            `PDF caught (${payload.pageCount} pages) — click "《 Pull Caught PDF Content" to load below.`
          );
        }
        return payload;
      } catch {
        const msg = "Network error while contacting PDF catcher endpoint.";
        setCatchError(msg);
        pushToast("err", msg);
        return null;
      } finally {
        setCatching(false);
      }
    },
    [pdfUrl, pushToast, refreshHistory, pullPayloadIntoSource]
  );

  /* ── Handler for "《 Pull Caught PDF Content" button ── */
  const handlePullCaughtContent = useCallback(async () => {
    const trimmed = pdfUrl.trim();
    if (
      caughtPayload &&
      (!trimmed || caughtPayload.sourceUrl === trimmed)
    ) {
      pullPayloadIntoSource(caughtPayload);
      return;
    }
    if (trimmed) {
      await catchPdfFromUrl(trimmed, true);
      return;
    }
    if (caughtPayload) {
      pullPayloadIntoSource(caughtPayload);
      return;
    }
    pushToast("err", "Paste a PDF URL first to catch and pull its content.");
  }, [pdfUrl, caughtPayload, pullPayloadIntoSource, catchPdfFromUrl, pushToast]);

  /* ── Load an archived PDF catch & pull immediately ── */
  const loadArchivedCatch = useCallback(
    async (id: number) => {
      setCatching(true);
      setCatchError(null);
      try {
        const res = await fetch(`/api/extract/${id}`);
        const data = await res.json();
        if (!res.ok) {
          pushToast("err", data.error || "Could not load archived PDF.");
          return;
        }
        const payload = data.payload as ExtractionPayload;
        setPdfUrl(payload.sourceUrl);
        setCaughtPayload(payload);
        setCaughtItemCount(data.itemCount ?? 0);
        pullPayloadIntoSource(payload);
      } catch {
        pushToast("err", "Could not load archived PDF.");
      } finally {
        setCatching(false);
      }
    },
    [pullPayloadIntoSource, pushToast]
  );

  /* ── Coordinate slots management ── */
  const addSlot = () => {
    setSlots((s) => [...s, ""]);
    setTimeout(() => slotRefs.current[slots.length]?.focus(), 30);
  };

  const removeSlot = (i: number) => {
    if (slots.length <= 1) {
      pushToast("err", "At least one coordinate must remain.");
      return;
    }
    setSlots((s) => s.filter((_, k) => k !== i));
  };

  /* ── Execute Smart Realignment (100% format-preserving for Rich PDF & Plain Text) ── */
  const execute = () => {
    const pool = slots.map((v) => v.trim()).filter((v) => v.length > 0);
    if (!pool.length) {
      pushToast("err", "Target coordinate list is empty.");
      return;
    }

    if (richSourceHtml !== null) {
      const currentHtml = sourceDocRef.current?.innerHTML ?? richSourceHtml;
      const checkText = extractPlainTextFromHtml(currentHtml);
      if (!checkText.trim()) {
        pushToast("err", "Source transmission block is empty.");
        return;
      }
      const res = realignRichHtml(currentHtml, pool, preserveFormat);
      if (res.modifiedCount === 0) {
        pushToast("err", "No signal structures detected in document.");
        return;
      }
      setOutputState({
        mode: "rich",
        html: res.html,
        plainText: res.plainText,
      });
      setAssignments(res.assignments);
      setStats({
        modified: res.modifiedCount,
        ms: res.elapsedMs.toFixed(1),
      });
      pushToast(
        "ok",
        `Realigned ${res.modifiedCount} coordinates — original PDF fonts, styles & layout 100% preserved.`
      );
      setTimeout(() => {
        outputCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 80);
      return;
    }

    if (!plainSource.trim()) {
      pushToast("err", "Source transmission text is absent.");
      return;
    }
    const spans = detectPhoneNumbers(plainSource);
    if (!spans.length) {
      pushToast("err", "No signal structures detected.");
      return;
    }
    const result = executeRealignment(plainSource, pool, preserveFormat);
    setOutputState({
      mode: "plain",
      html: plainTextToDocHtml(result.output),
      plainText: result.output,
    });
    setAssignments(result.assignments);
    setStats({ modified: result.modifiedCount, ms: result.elapsedMs.toFixed(1) });
    pushToast("ok", "Transmission successfully realigned.");
  };

  /* ── Copy Verified Transmission (Google-Docs-Grade Rich HTML + Plain Text) ── */
  const copyOut = async () => {
    if (!outputState || !outputState.plainText.trim()) {
      pushToast("err", "Log holds zero verified text. Execute Realignment first.");
      return;
    }
    try {
      const mode = await copyRichDocumentToClipboard(
        outputState.html,
        outputState.plainText
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
      pushToast(
        "ok",
        mode === "rich" && outputState.mode === "rich"
          ? "Copied with exact PDF fonts, sizes & formatting — paste (Ctrl+V) straight into Google Docs!"
          : "Transmission copied to clipboard."
      );
    } catch {
      pushToast("err", "Clipboard access blocked by browser.");
    }
  };

  /* ── Copy Source Document directly (optional pre-realign copy) ── */
  const copySourceDoc = async () => {
    if (richSourceHtml === null) return;
    const currentHtml = sourceDocRef.current?.innerHTML ?? richSourceHtml;
    const plain = extractPlainTextFromHtml(currentHtml);
    try {
      await copyRichDocumentToClipboard(currentHtml, plain);
      setCopiedSource(true);
      setTimeout(() => setCopiedSource(false), 2000);
      pushToast(
        "ok",
        "Original PDF content copied with full formatting — ready to paste in Google Docs."
      );
    } catch {
      pushToast("err", "Clipboard access blocked by browser.");
    }
  };

  const switchToPlainText = () => {
    if (richSourceHtml !== null) {
      const currentHtml = sourceDocRef.current?.innerHTML ?? richSourceHtml;
      setPlainSource(extractPlainTextFromHtml(currentHtml));
    }
    setRichSourceHtml(null);
    setActiveDocMeta(null);
    setOutputState(null);
    setStats(null);
    setAssignments([]);
  };

  const purge = () => {
    setPlainSource("");
    setRichSourceHtml(null);
    setActiveDocMeta(null);
    setSlots(["", ""]);
    setOutputState(null);
    setStats(null);
    setAssignments([]);
    setLiveScan(null);
    pushToast("info", "Log purged.");
  };

  return (
    <div className="rise-in space-y-8">
      {/* ══════════════════════════════════════════════════
          CARD 1 — MISSION CONTROL INPUTS
         ══════════════════════════════════════════════════ */}
      <section className="vcard p-6 sm:p-8">
        <h2 className="vh2 mb-6 text-base">
          <Satellite className="h-5 w-5 text-herogold" /> Mission Control Inputs
        </h2>

        {/* ── Integrated URL Content Catcher (GLM-5.3-FLASH) ── */}
        <div className="mb-7 rounded-md border border-[#24324a] bg-[#070c16]/90 p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="pdf-catcher-url" className="vlabel flex items-center gap-2 !text-heroblue">
              <Sparkles className="h-4 w-4 text-herogold" />
              URL Content Catcher
              <span className="font-mono rounded border border-herogold/40 bg-herogold/10 px-2 py-0.5 text-[10px] font-medium tracking-wider text-herogold">
                GLM-5.3-FLASH · EXACT PDF FORMAT
              </span>
            </label>

            <button
              type="button"
              onClick={handlePullCaughtContent}
              disabled={catching || (!caughtPayload && !pdfUrl.trim())}
              className="vbtn vbtn-gold vbtn-sm"
              title="Pull caught PDF content into Source Transmission Block with 100% original fonts, sizes, styles & layout"
            >
              <ChevronsLeft className="h-4 w-4" />
              《 Pull Caught PDF Content
            </button>
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-heroblue" />
              <input
                id="pdf-catcher-url"
                type="url"
                value={pdfUrl}
                onChange={(e) => setPdfUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !catching) {
                    e.preventDefault();
                    catchPdfFromUrl(undefined, true);
                  }
                }}
                placeholder="Paste PDF URL (e.g. https://actv.avmspa.it/sites/default/files/webform/surr010.pdf)"
                spellCheck={false}
                className="vfield py-3 pr-3.5 pl-10 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={() => catchPdfFromUrl(undefined, false)}
              disabled={catching}
              className="vbtn vbtn-blue shrink-0 !py-3"
            >
              {catching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              {catching ? "Catching…" : "Catch PDF"}
            </button>

            <button
              type="button"
              onClick={() => catchPdfFromUrl(undefined, true)}
              disabled={catching}
              className="vbtn vbtn-action shrink-0 !py-3"
              title="Catch PDF URL and immediately pull full formatted content below"
            >
              <ArrowDownToLine className="h-4 w-4" />
              Catch &amp; Pull
            </button>
          </div>

          {/* Quick sample + recent catches */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-textdim">
            <span className="tracking-wider uppercase">Sample PDF:</span>
            <button
              type="button"
              disabled={catching}
              onClick={() => catchPdfFromUrl(EXAMPLE_URL, true)}
              className="font-mono inline-flex max-w-full items-center gap-1.5 rounded border border-borderline bg-[#05080e] px-2.5 py-1 text-[11px] text-textlight transition-colors hover:border-herogold hover:text-herogold disabled:opacity-50"
            >
              <ExternalLink className="h-3 w-3 shrink-0 text-heroblue" />
              <span className="truncate">actv.avmspa.it/…/surr010.pdf</span>
            </button>

            {history.length > 0 && (
              <>
                <span className="ml-1 inline-flex items-center gap-1 tracking-wider text-textdim uppercase">
                  <History className="h-3 w-3 text-herogold" /> Recent:
                </span>
                {history.slice(0, 3).map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    disabled={catching}
                    onClick={() => loadArchivedCatch(h.id)}
                    className="inline-flex max-w-[170px] items-center gap-1 rounded border border-borderline bg-[#05080e] px-2.5 py-1 text-[11px] font-semibold text-textdim transition-colors hover:border-heroblue hover:text-heroblue"
                    title={h.url}
                  >
                    <span className="truncate">{h.title}</span>
                    <span className="opacity-60">({h.pageCount}p)</span>
                  </button>
                ))}
              </>
            )}
          </div>

          {catching && (
            <div className="rise-in mt-3.5 overflow-hidden rounded border border-borderline bg-[#05080e]">
              <div className="relative h-1 overflow-hidden bg-panelalt">
                <div className="scan-bar absolute h-full w-1/3 bg-heroblue" />
              </div>
              <div className="flex items-center gap-2.5 px-3.5 py-2.5 text-xs text-textlight">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-heroblue" />
                {CATCH_STEPS[catchStep]}
              </div>
            </div>
          )}

          {catchError && (
            <div className="rise-in mt-3.5 flex items-start gap-2.5 rounded border border-herored/50 bg-herored/10 px-3.5 py-2.5 text-xs text-[#ffb9bc]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-herored" />
              <span>{catchError}</span>
            </div>
          )}

          {caughtPayload && !catching && (
            <div className="rise-in mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded border border-heroblue/35 bg-heroblue/10 px-3.5 py-2.5 text-xs">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-textlight">
                <FileCheck2 className="h-4 w-4 shrink-0 text-herogold" />
                <span className="font-bold text-herogold">{caughtPayload.title}</span>
                <span className="text-textdim">
                  · {caughtPayload.pageCount} pages · {caughtItemCount.toLocaleString()} styled runs
                  {caughtPayload.imageCount ? ` · ${caughtPayload.imageCount} image(s)` : ""}
                </span>
                {caughtPayload.fonts.length > 0 && (
                  <span className="font-mono text-[11px] text-heroblue">
                    [{caughtPayload.fonts.slice(0, 4).join(", ")}]
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => pullPayloadIntoSource(caughtPayload)}
                className="vbtn vbtn-gold vbtn-sm"
              >
                《 Pull Caught PDF Content
              </button>
            </div>
          )}
        </div>

        {/* ── Source Transmission Block ── */}
        <div className="mb-6">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="source-block" className="vlabel">
              Source Transmission Block
            </label>

            {richSourceHtml !== null && activeDocMeta && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded border border-herogold/40 bg-herogold/10 px-2.5 py-1 text-[11px] font-bold tracking-wider text-herogold uppercase">
                  <FileText className="h-3.5 w-3.5" />
                  PDF Format Locked · {activeDocMeta.title} ({activeDocMeta.pageCount}p)
                </span>
                <button
                  type="button"
                  onClick={copySourceDoc}
                  className="vbtn vbtn-secondary vbtn-sm !py-1 !px-2.5"
                  title="Copy unedited PDF content with exact Google Docs formatting"
                >
                  {copiedSource ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
                  {copiedSource ? "Copied" : "Copy Source"}
                </button>
                {caughtPayload && (
                  <button
                    type="button"
                    onClick={() => pullPayloadIntoSource(caughtPayload)}
                    className="vbtn vbtn-secondary vbtn-sm !py-1 !px-2.5"
                    title="Reset to freshly caught PDF content"
                  >
                    <RotateCcw className="h-3 w-3" /> Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={switchToPlainText}
                  className="vbtn vbtn-secondary vbtn-sm !py-1 !px-2.5"
                  title="Convert to plain text mode"
                >
                  Raw Text Mode
                </button>
              </div>
            )}
          </div>

          {richSourceHtml !== null ? (
            <div className="pdf-doc-shell">
              <div
                ref={sourceDocRef}
                contentEditable
                suppressContentEditableWarning
                onInput={() => {
                  if (!sourceDocRef.current) return;
                  setLiveScan(scanSignalsInHtml(sourceDocRef.current.innerHTML));
                }}
                className="pdf-doc-page"
                aria-label="Rich PDF Source Transmission Document"
              />
            </div>
          ) : (
            <textarea
              id="source-block"
              value={plainSource}
              onChange={(e) => setPlainSource(e.target.value)}
              onPaste={(e) => {
                const html = e.clipboardData?.getData("text/html");
                if (
                  html &&
                  /<(b|strong|i|em|u|s|img|table|h[1-6]|font)\b|font-size:|font-weight:|color:|background-color:/i.test(
                    html
                  )
                ) {
                  const clean = sanitizePastedRichHtml(html);
                  if (clean.trim()) {
                    e.preventDefault();
                    setRichSourceHtml(clean);
                    setRichSourceNonce((n) => n + 1);
                    setActiveDocMeta({
                      title: "Rich Clipboard Document",
                      pageCount: 1,
                      fonts: [],
                    });
                    setOutputState(null);
                    setStats(null);
                    setAssignments([]);
                    setLiveScan(scanSignalsInHtml(clean));
                    pushToast(
                      "ok",
                      "Rich formatted content pasted — fonts, colors, bold/italic & images locked!"
                    );
                  }
                }
              }}
              placeholder="Paste multi-line transmission text (or rich formatted content) here — OR paste a PDF URL above and click 《 Pull Caught PDF Content…"
              spellCheck={false}
              className="vfield h-64 resize-y p-4 text-sm leading-relaxed"
            />
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-textdim">
            {liveScan !== null && (
              <span className="stats-badge">
                <ScanSearch className="h-3.5 w-3.5" />
                {liveScan.total.toLocaleString()} signal occurrence
                {liveScan.total === 1 ? "" : "s"} ({liveScan.unique} unique pattern
                {liveScan.unique === 1 ? "" : "s"}) locked
              </span>
            )}
            <span>
              {richSourceHtml !== null
                ? "Original PDF fonts, pt sizes, bold/italic, symbols/stickers & paragraph layout are active and directly editable."
                : "Unicode digits supported: ٠١٢ · ०१२ · ⁰¹² · 𝟘𝟙𝟚 · ①②③"}
            </span>
          </div>
        </div>

        {/* ── Target Realignment Coordinates ── */}
        <div className="mb-2">
          <span className="vlabel mb-2.5">Target Realignment Coordinates</span>
          <div className="mb-3.5 flex flex-col gap-2.5">
            {slots.map((val, i) => (
              <div key={i} className="number-slot">
                <span className="slot-index">{i + 1}</span>
                <input
                  ref={(el) => {
                    slotRefs.current[i] = el;
                  }}
                  type="text"
                  value={val}
                  onChange={(e) =>
                    setSlots((s) => s.map((v, k) => (k === i ? e.target.value : v)))
                  }
                  onKeyDown={(e) => e.key === "Enter" && execute()}
                  placeholder={`Enter replacement number ${i + 1}`}
                  className="vfield flex-1 px-3.5 py-3 text-[15px] tracking-wider"
                />
                {slots.length > 1 && (
                  <button
                    type="button"
                    className="remove-slot"
                    onClick={() => removeSlot(i)}
                    title="Remove this coordinate"
                    aria-label={`Remove coordinate ${i + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addSlot}
            className="vbtn w-full border-dashed !border-heroblue-dim text-heroblue hover:!bg-heroblue hover:!text-void"
          >
            <Plus className="h-4 w-4" /> Add Another Number
          </button>
          <p className="mt-2 text-[12.5px] text-textdim">
            Each coordinate transmits on its own secured channel — inputs never merge, no matter how many you add.
          </p>
        </div>

        {/* ── Action Controls ── */}
        <div className="mt-6 flex flex-wrap items-center gap-3.5">
          <button type="button" className="vbtn vbtn-action" onClick={execute}>
            <Zap className="h-4 w-4" /> Execute Realignment
          </button>
          <button type="button" className="vbtn vbtn-gold" onClick={copyOut}>
            {copied ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
            {copied ? "Copied for Google Docs!" : "Copy Transmission"}
          </button>
          <button type="button" className="vbtn vbtn-secondary" onClick={purge}>
            <Trash2 className="h-4 w-4" /> Purge Log
          </button>

          <label className="ml-auto flex cursor-pointer items-center gap-2.5 text-[0.8rem] font-semibold tracking-wider text-textdim uppercase select-none">
            <input
              type="checkbox"
              checked={preserveFormat}
              onChange={(e) => setPreserveFormat(e.target.checked)}
              className="h-4 w-4 accent-heroblue"
            />
            <span>Preserve Original Format</span>
          </label>
        </div>

        {stats && (
          <div className="stats-badge rise-in mt-5">
            <Activity className="h-3.5 w-3.5" />
            System Log: Realigned {stats.modified.toLocaleString()} coordinates in {stats.ms}ms — 100% document style preserved.
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════
          CARD 2 — VERIFIED TRANSMISSION LOG
         ══════════════════════════════════════════════════ */}
      <section ref={outputCardRef} className="vcard p-6 sm:p-8">
        <div className="vh2 mb-5 flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-3">
            <Radio className="h-5 w-5 text-herogold" /> Verified Transmission Log
          </span>

          {outputState && (
            <button
              type="button"
              onClick={copyOut}
              className="vbtn vbtn-gold vbtn-sm font-sans"
              title="Copy formatted document — paste (Ctrl+V) directly into Google Docs with identical fonts, sizes & layout"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              {copied ? "Copied — Paste in Google Docs!" : "Copy for Google Docs"}
            </button>
          )}
        </div>

        {outputState === null ? (
          <div className="output-box min-h-[220px] p-5 text-[14.5px]">
            <span className="text-[#3a465c] italic">
              Reconstructed signal streams will render across this viewport with 100% original PDF fonts, sizes, stickers &amp; layout…
            </span>
          </div>
        ) : outputState.mode === "rich" ? (
          <div className="pdf-doc-shell lit">
            <div
              className="pdf-doc-page"
              dangerouslySetInnerHTML={{ __html: outputState.html }}
            />
          </div>
        ) : (
          <div className="output-box lit min-h-[220px] p-5 text-[14.5px]">
            {outputState.plainText}
          </div>
        )}

        {outputState?.mode === "rich" && (
          <p className="mt-3 text-xs text-textdim">
            <Check className="mr-1.5 inline h-3.5 w-3.5 text-herogold" />
            Google Docs Ready: Click <strong>Copy Transmission</strong> (or <strong>Copy for Google Docs</strong>) and press{" "}
            <kbd className="font-mono rounded border border-borderline bg-[#060a12] px-1.5 py-0.5 text-[10px] text-textlight">
              Ctrl+V
            </kbd>{" "}
            in Google Docs — exact fonts, point sizes, bold/italic, symbols/stickers &amp; paragraph spacing paste identically to the PDF.
          </p>
        )}

        {assignments.length > 0 && (
          <div className="rise-in mt-5">
            <p className="vlabel mb-2.5 flex items-center gap-2">
              <Crosshair className="h-4 w-4 text-herogold" /> Channel Assignment Map
            </p>
            <div className="overflow-x-auto rounded border border-borderline">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-[#060a12] text-[0.7rem] tracking-widest text-textdim uppercase">
                    <th className="px-4 py-2.5 font-semibold">Ch</th>
                    <th className="px-4 py-2.5 font-semibold">Detected signal</th>
                    <th className="px-4 py-2.5 font-semibold">Realigned to</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[13px]">
                  {assignments.map((a, i) => (
                    <tr
                      key={i}
                      className="border-t border-borderline transition-colors hover:bg-[#0c1322]"
                    >
                      <td className="px-4 py-2">
                        <span className="slot-index">{i + 1}</span>
                      </td>
                      <td className="px-4 py-2 text-textdim">{a.raw}</td>
                      <td className="px-4 py-2 text-herogold">{a.replacement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <span className="chip">
            <ListPlus className="h-3.5 w-3.5 text-heroblue" /> Separate slots — zero merge
          </span>
          <span className="chip">
            <Check className="h-3.5 w-3.5 text-herogold" /> Same PDF font, size, style &amp; Google Docs paste
          </span>
        </div>
      </section>
    </div>
  );
}
