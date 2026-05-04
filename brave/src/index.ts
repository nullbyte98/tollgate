/**
 * Tollgate-paywalled Brave Search HTTP server.
 *
 * Endpoints (each wrapped with @tollgate/sdk's wrapTool):
 *   POST /tools/brave_web_search   — body: {query, count?, offset?}, price 0.005 USDC
 *   POST /tools/brave_local_search — body: {query, count?},          price 0.008 USDC
 *
 * Each endpoint:
 *   - Returns 402 Payment Required with on-chain escrow terms on first hit
 *   - On retry with X-PAYMENT proof: opens Brave call. On success → claims
 *     escrow with sha256(response). On Brave 5xx / parse error → throws →
 *     wrapTool auto-refunds the escrow.
 *
 * Env:
 *   RPC_URL        Solana RPC (default devnet)
 *   NETWORK        "solana-devnet" | "solana-mainnet"
 *   MINT           SPL mint to quote prices in (USDC)
 *   SERVER_WALLET  path to keypair JSON
 *   PORT           default 3402
 *   BRAVE_API_KEY  optional — without it, /tools/brave_*_search return mock
 *                  results clearly tagged "[mock]" so the demo flow works
 *                  without signing up
 */
import express, { Request, Response } from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { wrapTool, PAYMENT_HEADER } from "@tollgate/sdk";
import { performWebSearch, performLocalSearch } from "./brave";

const PORT = parseInt(process.env.PORT ?? "3402", 10);
const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const NETWORK = (process.env.NETWORK ?? "solana-devnet") as
  | "solana-devnet"
  | "solana-mainnet";
const MINT = new PublicKey(
  process.env.MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const BRAVE_API_KEY = process.env.BRAVE_API_KEY ?? null;

function loadServerWallet(): Keypair {
  const p =
    process.env.SERVER_WALLET ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))
  );
}

const wallet = loadServerWallet();
const connection = new Connection(RPC_URL, "confirmed");

console.log(`tollgate-brave-server`);
console.log(`  rpc:      ${RPC_URL}`);
console.log(`  network:  ${NETWORK}`);
console.log(`  server:   ${wallet.publicKey.toBase58()}`);
console.log(`  mint:     ${MINT.toBase58()}`);
console.log(`  brave:    ${BRAVE_API_KEY ? "real (key present)" : "MOCK (no BRAVE_API_KEY)"}`);

const webSearchTool = wrapTool<
  { query: string; count?: number; offset?: number },
  Awaited<ReturnType<typeof performWebSearch>>
>(
  ({ query, count, offset }) =>
    performWebSearch({ apiKey: BRAVE_API_KEY, query, count, offset }),
  {
    endpointId: "tool:brave-web-search-v1",
    connection,
    serverWallet: wallet,
    mint: MINT,
    amount: new BN(5_000), // 0.005 USDC
    network: NETWORK,
    deadlineSeconds: 300,
  }
);

const localSearchTool = wrapTool<
  { query: string; count?: number },
  Awaited<ReturnType<typeof performLocalSearch>>
>(
  ({ query, count }) =>
    performLocalSearch({ apiKey: BRAVE_API_KEY, query, count }),
  {
    endpointId: "tool:brave-local-search-v1",
    connection,
    serverWallet: wallet,
    mint: MINT,
    amount: new BN(8_000), // 0.008 USDC
    network: NETWORK,
    deadlineSeconds: 300,
  }
);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    server: wallet.publicKey.toBase58(),
    brave: BRAVE_API_KEY ? "real" : "mock",
  });
});

async function handle<I, O>(
  req: Request,
  res: Response,
  tool: ReturnType<typeof wrapTool<I, O>>,
  input: I
) {
  const header = req.header(PAYMENT_HEADER);
  const result = await tool.serve(input, header ?? null);
  if (result.kind === "402") {
    res.status(402).json(result.body);
    return;
  }
  if (result.kind === "ok") {
    res.status(200).json({
      output: result.output,
      escrow: result.escrow.toBase58(),
      claimSignature: result.signature,
    });
    return;
  }
  if (result.kind === "in_use") {
    res.status(409).json({ error: result.error.message });
    return;
  }
  res.status(500).json({
    error: result.error.message,
    refundedEscrow: result.refundedEscrow?.toBase58(),
  });
}

app.post("/tools/brave_web_search", async (req, res) => {
  try {
    await handle(req, res, webSearchTool, req.body);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/tools/brave_local_search", async (req, res) => {
  try {
    await handle(req, res, localSearchTool, req.body);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`  listening on http://localhost:${PORT}`);
  console.log(`  POST /tools/brave_web_search    (0.005 USDC)`);
  console.log(`  POST /tools/brave_local_search  (0.008 USDC)`);
});
