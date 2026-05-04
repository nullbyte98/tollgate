/**
 * End-to-end demo: pay → call → claim, then pay → call (failing) → auto-refund.
 *
 * Usage:
 *   PAYER_WALLET=~/.config/solana/id.json RPC_URL=http://127.0.0.1:8899 \
 *     MINT=<mint> SERVER_URL=http://localhost:3001 tsx src/demo-client.ts
 */
import { Connection, Keypair, clusterApiUrl, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import { payAndCall, TollgateClient } from "@tollgate/sdk";

const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3001";

function loadWallet(): Keypair {
  const p =
    process.env.PAYER_WALLET ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const payer = loadWallet();
  const connection = new Connection(RPC_URL, "confirmed");
  const client = TollgateClient.withWallet(connection, payer);

  console.log(`payer:  ${payer.publicKey.toBase58()}`);
  console.log(`server: ${SERVER_URL}`);
  console.log();

  // ─── Demo 1: successful paid call ────────────────────────────────────
  console.log("── 1. paid web search (should succeed and claim) ──");
  const r1 = await payAndCall({
    url: `${SERVER_URL}/tools/search`,
    payer,
    connection,
    fetchInit: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "solana x402" }),
    },
    maxAmount: new BN(10_000),
  });
  const body1 = (await r1.response.json()) as any;
  console.log(`status:  ${r1.response.status}`);
  console.log(`escrow:  ${r1.escrow?.toBase58()}`);
  console.log(`output:  ${JSON.stringify(body1.output)}`);

  if (r1.escrow) {
    const acc = await client.fetchEscrow(r1.escrow);
    console.log(`onchain: status=${acc.status}, receipt=${acc.receipt.toString("hex").slice(0, 16)}…`);
  }
  console.log();

  // ─── Demo 2: failing call → auto-refund ──────────────────────────────
  console.log("── 2. paid rerank with failMode (should refund) ──");
  const r2 = await payAndCall({
    url: `${SERVER_URL}/tools/rerank`,
    payer,
    connection,
    fetchInit: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["a", "b"], query: "x", failMode: true }),
    },
    maxAmount: new BN(10_000),
  });
  const body2 = (await r2.response.json()) as any;
  console.log(`status:  ${r2.response.status}`);
  console.log(`error:   ${body2.error}`);
  console.log(`refunded escrow: ${body2.refundedEscrow}`);

  if (body2.refundedEscrow) {
    const acc = await client.fetchEscrow(new PublicKey(body2.refundedEscrow));
    console.log(`onchain: status=${acc.status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
