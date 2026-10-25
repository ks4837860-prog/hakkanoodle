import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { extractions } from "@/db/schema";
import { extractPdf } from "@/lib/pdf-extract";
import { payloadBlockCount } from "@/lib/doc-html";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const num = Number(id);
  if (!Number.isInteger(num) || num <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  try {
    const [row] = await db
      .select()
      .from(extractions)
      .where(eq(extractions.id, num))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // If an older cached row pre-dates the rich block schema, re-extract seamlessly from URL
    if (!Array.isArray((row.payload as { blocks?: unknown })?.blocks)) {
      const res = await fetch(row.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        return NextResponse.json({ error: "Legacy entry unavailable." }, { status: 404 });
      }
      const buf = await res.arrayBuffer();
      const fresh = await extractPdf(buf, row.url);
      const itemCount = payloadBlockCount(fresh);
      return NextResponse.json({ id: row.id, payload: fresh, itemCount });
    }

    const itemCount = payloadBlockCount(row.payload);
    return NextResponse.json({ id: row.id, payload: row.payload, itemCount });
  } catch {
    return NextResponse.json(
      { error: "History is unavailable right now." },
      { status: 500 }
    );
  }
}
