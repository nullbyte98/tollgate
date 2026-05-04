#!/usr/bin/env node
/**
 * Tollgate MCP shim — speaks MCP/stdio to the agent, speaks HTTP+x402 to the
 * tollgate-server. The agent has no idea it's paying. The shim opens an escrow
 * per call, retries with X-PAYMENT, and surfaces the on-chain settlement back
 * to the agent.
 *
 * Env:
 *   RPC_URL              Solana RPC (default: devnet)
 *   PAYER_WALLET         path to keypair JSON
 *   TOLLGATE_SERVER_URL  base URL of the tollgate HTTP server
 *   MAX_USDC_PER_CALL    refuse quotes above this (in raw units, 6-decimal USDC)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { payAndCall } from "@tollgate/sdk";

const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const SERVER_URL = process.env.TOLLGATE_SERVER_URL;
const BRAVE_SERVER_URL = process.env.TOLLGATE_BRAVE_URL;
const MAX = new BN(process.env.MAX_USDC_PER_CALL ?? "10000");

if (!SERVER_URL) {
  console.error("TOLLGATE_SERVER_URL is required");
  process.exit(1);
}

function loadPayer(): Keypair {
  const p =
    process.env.PAYER_WALLET ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const payer = loadPayer();
const connection = new Connection(RPC_URL, "confirmed");

// Log to stderr so it doesn't pollute the stdio MCP channel.
console.error(
  JSON.stringify({
    msg: "tollgate-mcp starting",
    rpc: RPC_URL,
    server: SERVER_URL,
    payer: payer.publicKey.toBase58(),
    maxUsdcPerCall: MAX.toString(),
  })
);

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  base: string;
  endpoint: string;
};

const TOOLS: ToolDef[] = [
  {
    name: "web_search",
    description:
      "Paid web search via Tollgate. Each call opens a Solana escrow for ~0.001 USDC; the server claims on attested success or auto-refunds on handler error.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "search query" } },
      required: ["q"],
    },
    base: SERVER_URL!,
    endpoint: "/tools/search",
  },
  {
    name: "rerank",
    description:
      "Paid LLM-style rerank via Tollgate. Takes items[] + query, returns items ordered by query-overlap. Same escrow + auto-refund flow as web_search.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        failMode: {
          type: "boolean",
          description:
            "Demo flag — when true the server's handler throws, exercising auto-refund.",
        },
      },
      required: ["items", "query"],
    },
    base: SERVER_URL!,
    endpoint: "/tools/rerank",
  },
];

if (BRAVE_SERVER_URL) {
  TOOLS.push(
    {
      name: "brave_web_search",
      description:
        "Paid web search via the Brave Search API, gated by Tollgate (forked from the official MCP brave-search server). Each call opens a Solana escrow for ~0.005 USDC; if Brave 5xxs or rate-limits, the handler throws and the escrow refunds automatically.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (max 400 chars)" },
          count: { type: "number", description: "1-20, default 10" },
          offset: { type: "number", description: "0-9, default 0" },
        },
        required: ["query"],
      },
      base: BRAVE_SERVER_URL,
      endpoint: "/tools/brave_web_search",
    },
    {
      name: "brave_local_search",
      description:
        "Paid local-business search via Brave's Local Search API (forked from official MCP brave-search). 0.008 USDC per call. Falls back to web search if no local results, and auto-refunds on Brave failure.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "1-20, default 5" },
        },
        required: ["query"],
      },
      base: BRAVE_SERVER_URL,
      endpoint: "/tools/brave_local_search",
    }
  );
}

const server = new Server(
  { name: "tollgate-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
    };
  }

  const url = `${tool.base}${tool.endpoint}`;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    const { response, escrow } = await payAndCall({
      url,
      payer,
      connection,
      maxAmount: MAX,
      fetchInit: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      },
    });

    const body = (await response.json()) as any;

    if (response.status === 200) {
      return {
        content: [
          { type: "text", text: JSON.stringify(body.output, null, 2) },
          {
            type: "text",
            text: `\n_paid via tollgate escrow ${escrow?.toBase58() ?? "(none)"}: claim ${body.claimSignature?.slice(0, 12) ?? "?"}…_`,
          },
        ],
      };
    }

    if (response.status === 500 && body.refundedEscrow) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `tool failed and refund was issued. error: ${body.error}\nrefunded escrow: ${body.refundedEscrow}`,
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `unexpected ${response.status}: ${JSON.stringify(body)}`,
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `tollgate-mcp error: ${(err as Error).message}`,
        },
      ],
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(JSON.stringify({ msg: "tollgate-mcp ready" }));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: "tollgate-mcp fatal", error: String(e) }));
  process.exit(1);
});
