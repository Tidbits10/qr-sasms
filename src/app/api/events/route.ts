import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";




export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`));
      timer = setInterval(() => controller.enqueue(encoder.encode(`event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)), 3000);
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new NextResponse(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
