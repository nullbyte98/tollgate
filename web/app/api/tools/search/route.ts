import { NextRequest } from "next/server";
import { handle } from "@/lib/handler";
import { searchTool } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handle(req, searchTool());
}
