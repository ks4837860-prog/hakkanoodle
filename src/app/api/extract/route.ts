import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { extractions } from "@/db/schema";
import { extractPdf } from "@/lib/pdf-extract";
import { payloadBlockCount } from "@/lib/doc-html";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest) {
  let url: string;
  try {
    const body = (await req.json()) as { url?: string };
    url = (body.url || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!url) {
    return NextResponse.json({ error: "PDF URL is required." }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json(
      {
        error:
          "That doesn't look like a valid URL. Paste the full https:// link to the PDF.",
      },
      { status: 400 }
    );
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return NextResponse.json(
      { error: "Only http:// and https:// URLs are supported." },
      { status: 400 }
    );
  }

  let buffer: ArrayBuffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/pdf,*/*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return NextResponse.json(
        {
          error: `The server responded with HTTP ${res.status} (${res.statusText || "error"}). Check that the link is public and points directly to a PDF file.`,
        },
        { status: 502 }
      );
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) {
      return NextResponse.json(
        { error: "PDF is larger than 25 MB — please use a smaller file." },
        { status: 413 }
      );
    }
    buffer = await res.arrayBuffer();
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? "The download timed out after 45 seconds."
        : "Could not download the file. The host may be blocking requests or the URL is unreachable.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  if (buffer.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: "PDF is larger than 25 MB — please use a smaller file." },
      { status: 413 }
    );
  }
  const head = new TextDecoder("latin1").decode(
    new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength))
  );
  if (!head.includes("%PDF")) {
    return NextResponse.json(
      {
        error:
          "That URL did not return a PDF file (no %PDF header found). Make sure the link ends in .pdf or serves a PDF directly.",
      },
      { status: 415 }
    );
  }

  try {
    const payload = await extractPdf(buffer, parsed.toString());
    const itemCount = payloadBlockCount(payload);
    if (itemCount === 0) {
      return NextResponse.json(
        {
          error:
            "This PDF has no extractable text or graphics — it may be an empty or scanned image-only file.",
        },
        { status: 422 }
      );
    }

    let id: number | null = null;
    try {
      const [row] = await db
        .insert(extractions)
        .values({
          url: parsed.toString(),
          title: payload.title,
          pageCount: payload.pageCount,
          itemCount,
          payload,
        })
        .returning({ id: extractions.id });
      id = row.id;
    } catch {
      /* history persistence is best-effort */
    }

    return NextResponse.json({ id, payload, itemCount });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: `Failed to parse the PDF: ${detail}` },
      { status: 422 }
    );
  }
}

export async function GET() {
  try {
    const rows = await db
      .select()
      .from(extractions)
      .orderBy(desc(extractions.createdAt))
      .limit(12);

    const entries = rows
      .filter((r) => Array.isArray((r.payload as { blocks?: unknown })?.blocks))
      .map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        pageCount: r.pageCount,
        itemCount: r.itemCount,
        createdAt: r.createdAt,
      }));
    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
