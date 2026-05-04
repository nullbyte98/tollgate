import { NextRequest, NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { TollgateClient, TOLLGATE_PROGRAM_ID } from "@/lib/tollgate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl("devnet");

function readClient() {
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new NodeWallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  return new TollgateClient(provider, TOLLGATE_PROGRAM_ID);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pubkey = searchParams.get("pubkey");
  const role = searchParams.get("role");

  if (!pubkey || (role !== "payer" && role !== "server")) {
    return NextResponse.json({ error: "missing pubkey or invalid role" }, { status: 400 });
  }

  let pk: PublicKey;
  try {
    pk = new PublicKey(pubkey);
  } catch {
    return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });
  }

  const client = readClient();
  const accs =
    role === "payer"
      ? await client.listEscrowsForPayer(pk)
      : await client.listEscrowsForServer(pk);

  return NextResponse.json({
    escrows: accs.map((a) => ({
      address: a.address.toBase58(),
      payer: a.payer.toBase58(),
      server: a.server.toBase58(),
      mint: a.mint.toBase58(),
      amount: a.amount.toString(),
      deadline: a.deadline.toNumber(),
      openedAt: a.openedAt.toNumber(),
      settledAt: a.settledAt.toNumber(),
      status: a.status,
      receiptHex: a.receipt.toString("hex"),
    })),
  });
}
