/**
 * One-click public demo. Visitor hits POST /api/demo/try?kind=claim|refund;
 * server-side payer wallet opens an escrow against this deployment's own
 * tollgate server, calls the tool, and returns the escrow address + outcome.
 *
 * Visitor doesn't need a wallet. The payer wallet is funded with devnet test
 * USDC; the server wallet earns the claims (so net cost per demo call is just
 * SOL gas + the escrow rent, both small). On `kind=refund` the failMode flag
 * makes the handler throw and the escrow auto-refunds back to the payer.
 */
import { NextRequest, NextResponse } from "next/server";
import BN from "bn.js";
import { payAndCall } from "@/lib/tollgate";
import { demoPayerWallet, makeConnection } from "@/lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_CALL = new BN(10_000); // 0.01 USDC ceiling for the public demo

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const kind = (searchParams.get("kind") ?? "claim") as "claim" | "refund";

  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
  if (!host) {
    return NextResponse.json({ error: "missing host header" }, { status: 500 });
  }
  const origin = `${proto}://${host}`;

  let payer;
  try {
    payer = demoPayerWallet();
  } catch (e: any) {
    return NextResponse.json(
      { error: `demo payer not configured: ${e.message}` },
      { status: 500 }
    );
  }

  const connection = makeConnection();

  // claim → call /api/tools/search; refund → call /api/tools/rerank with failMode
  const target =
    kind === "refund" ? "/api/tools/rerank" : "/api/tools/search";
  const body =
    kind === "refund"
      ? JSON.stringify({ items: ["a", "b"], query: "x", failMode: true })
      : JSON.stringify({ q: `tollgate demo ${new Date().toISOString()}` });

  try {
    const { response, escrow } = await payAndCall({
      url: `${origin}${target}`,
      payer,
      connection,
      maxAmount: MAX_PER_CALL,
      fetchInit: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    });

    const out = (await response.json()) as any;

    return NextResponse.json({
      kind,
      payer: payer.publicKey.toBase58(),
      escrow: escrow?.toBase58() ?? null,
      status: response.status,
      output: response.status === 200 ? out.output : undefined,
      error: response.status !== 200 ? out.error : undefined,
      refundedEscrow: out.refundedEscrow ?? undefined,
      claimSignature: out.claimSignature ?? undefined,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `try-it failed: ${e.message}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  // convenience for clicking from a browser — hint to use POST
  return NextResponse.json({
    info: "POST to /api/demo/try?kind=claim or ?kind=refund",
  });
}
