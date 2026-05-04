import { NextResponse } from "next/server";
import { manifest } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(manifest());
}
