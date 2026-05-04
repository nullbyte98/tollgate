import { NextRequest, NextResponse } from "next/server";
import { WrappedTool, PAYMENT_HEADER } from "@/lib/tollgate";

export async function handle<I, O>(
  req: NextRequest,
  tool: WrappedTool<I, O>
): Promise<NextResponse> {
  let input: I;
  try {
    input = (await req.json()) as I;
  } catch {
    input = {} as I;
  }
  const header = req.headers.get(PAYMENT_HEADER);
  const result = await tool.serve(input, header);

  if (result.kind === "402") return NextResponse.json(result.body, { status: 402 });

  if (result.kind === "ok") {
    return NextResponse.json(
      {
        output: result.output,
        escrow: result.escrow.toBase58(),
        claimSignature: result.signature,
      },
      { status: 200 }
    );
  }

  if (result.kind === "in_use") {
    return NextResponse.json({ error: result.error.message }, { status: 409 });
  }

  return NextResponse.json(
    {
      error: result.error.message,
      refundedEscrow: result.refundedEscrow?.toBase58(),
    },
    { status: 500 }
  );
}
