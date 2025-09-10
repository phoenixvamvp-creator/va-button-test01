// app/api/realtime/offer/route.ts  (Next.js App Router)
// Minimal proxy: browser sends SDP offer -> we forward to OpenAI -> return SDP answer.
// Keep your OpenAI key here only (never in the browser).

import { NextRequest, NextResponse } from "next/server";

const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN; // e.g. https://your-domain.vercel.app

export async function POST(req: NextRequest) {
  // Basic origin lock (optional but recommended)
  const origin = req.headers.get("origin") || "";
  if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new NextResponse("Missing OPENAI_API_KEY", { status: 500 });

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/sdp")) {
    return new NextResponse("Expected application/sdp", { status: 400 });
  }

  const sdpOffer = await req.text(); // raw SDP from browser

  // Forward the SDP offer to OpenAI Realtime
  const oaRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/sdp",
    },
    body: sdpOffer,
  });

  if (!oaRes.ok) {
    const errText = await oaRes.text().catch(() => "OpenAI error");
    return new NextResponse(`OpenAI Realtime error: ${errText}`, { status: oaRes.status });
    }

  const sdpAnswer = await oaRes.text();

  // Return the SDP answer straight back to the browser
  return new NextResponse(sdpAnswer, {
    status: 200,
    headers: { "Content-Type": "application/sdp" },
  });
}
