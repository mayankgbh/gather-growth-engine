import { NextResponse } from "next/server";

// Built once at deploy, as Next.js 14 did for a GET that reads nothing from the request.
export const dynamic = "force-static";

/**
 * GET: Returns which auth providers are enabled (e.g. for showing "Continue with Google").
 * No auth required.
 */
export async function GET() {
  const googleEnabled = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
  return NextResponse.json({ google: googleEnabled });
}
