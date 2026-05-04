import express, { Request, Response } from "express";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { wrapTool, PAYMENT_HEADER } from "@tollgate/sdk";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const NETWORK = (process.env.NETWORK ?? "solana-devnet") as
  | "solana-devnet"
  | "solana-mainnet";

const MINT = new PublicKey(
  process.env.MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

function loadServerWallet(): Keypair {
  const p = process.env.SERVER_WALLET ?? path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const wallet = loadServerWallet();
const connection = new Connection(RPC_URL, "confirmed");

console.log(`tollgate-demo-server`);
console.log(`  rpc:      ${RPC_URL}`);
console.log(`  network:  ${NETWORK}`);
console.log(`  server:   ${wallet.publicKey.toBase58()}`);
console.log(`  mint:     ${MINT.toBase58()}`);

// ─── Tool 1: paid web search (always succeeds) ────────────────────────────
const searchTool = wrapTool<{ q: string }, { q: string; results: string[] }>(
  async ({ q }) => {
    if (typeof q !== "string" || q.length === 0) {
      throw new Error("missing query");
    }
    return {
      q,
      results: [
        `${q} — top result (mocked)`,
        `${q} — second result`,
        `${q} — third result`,
      ],
    };
  },
  {
    endpointId: "tool:search-v1",
    connection,
    serverWallet: wallet,
    mint: MINT,
    amount: new BN(1_000), // 0.001 USDC
    network: NETWORK,
    deadlineSeconds: 300,
  }
);

// ─── Tool 3: paid OpenAI chat (real if OPENAI_API_KEY set, else mock) ────
// Demonstrates that *any* paid HTTP API can be wrapped — same shape as Brave.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null;
const openaiTool = wrapTool<
  { model?: string; prompt: string },
  { content: string; model: string; mocked: boolean }
>(
  async ({ model, prompt }) => {
    if (!prompt) throw new Error("missing prompt");
    const useModel = model ?? "gpt-4o-mini";
    if (!OPENAI_API_KEY) {
      return {
        mocked: true,
        model: useModel,
        content: `[mock] would have asked ${useModel}: "${prompt.slice(0, 80)}". Set OPENAI_API_KEY for real responses.`,
      };
    }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const body = (await r.json()) as any;
    return {
      mocked: false,
      model: useModel,
      content: body.choices?.[0]?.message?.content ?? "",
    };
  },
  {
    endpointId: "tool:openai-chat-v1",
    connection,
    serverWallet: wallet,
    mint: MINT,
    amount: new BN(20_000), // 0.02 USDC, covers a typical small chat call
    network: NETWORK,
    deadlineSeconds: 300,
  }
);

// ─── Tool 2: paid LLM rerank (configurable fail to demo refund) ───────────
const rerankTool = wrapTool<
  { items: string[]; query: string; failMode?: boolean },
  { ranked: string[] }
>(
  async ({ items, query, failMode }) => {
    if (failMode) {
      throw new Error("simulated tool failure — refund triggered");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("items must be a non-empty array");
    }
    const scored = items
      .map((it) => ({ it, s: (it.match(new RegExp(query, "gi")) ?? []).length }))
      .sort((a, b) => b.s - a.s)
      .map(({ it }) => it);
    return { ranked: scored };
  },
  {
    endpointId: "tool:rerank-v1",
    connection,
    serverWallet: wallet,
    mint: MINT,
    amount: new BN(2_000), // 0.002 USDC
    network: NETWORK,
    deadlineSeconds: 300,
  }
);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, server: wallet.publicKey.toBase58() });
});

app.get("/mcp/manifest", (_req, res) => {
  res.json({
    server: wallet.publicKey.toBase58(),
    version: 1,
    tools: [
      {
        name: "web_search",
        description:
          "Mock paid web search via Tollgate. Each call opens a Solana escrow for 0.001 USDC; the server claims on attested success or auto-refunds on handler error.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string", description: "search query" } },
          required: ["q"],
        },
        endpoint: "/tools/search",
        endpointId: "tool:search-v1",
        amount: "1000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
      {
        name: "openai_chat",
        description: `Paid OpenAI chat via Tollgate (${OPENAI_API_KEY ? "real" : "mock"} mode). Demonstrates that any paid HTTP API drops in. Refunds automatically on OpenAI 5xx / 429 / parse error.`,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            model: { type: "string", description: "default: gpt-4o-mini" },
          },
          required: ["prompt"],
        },
        endpoint: "/tools/openai_chat",
        endpointId: "tool:openai-chat-v1",
        amount: "20000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
      {
        name: "rerank",
        description:
          "Mock paid LLM-style rerank via Tollgate. Pass {failMode:true} to exercise auto-refund.",
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
            query: { type: "string" },
            failMode: { type: "boolean" },
          },
          required: ["items", "query"],
        },
        endpoint: "/tools/rerank",
        endpointId: "tool:rerank-v1",
        amount: "2000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
    ],
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

app.post("/tools/search", async (req, res) => {
  try {
    await handle(req, res, searchTool, req.body);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/tools/openai_chat", async (req, res) => {
  try {
    await handle(req, res, openaiTool, req.body);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/tools/rerank", async (req, res) => {
  try {
    await handle(req, res, rerankTool, req.body);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`  listening on http://localhost:${PORT}`);
  console.log(`  POST /tools/search   (0.001 USDC)`);
  console.log(`  POST /tools/rerank   (0.002 USDC, pass {failMode:true} to test refund)`);
});
