#!/usr/bin/env node
/**
 * Tollgate MCP shim — speaks MCP/stdio to the agent, speaks HTTP+x402 to any
 * Tollgate-wrapped HTTP server. Tools are discovered dynamically at startup
 * by fetching `GET /mcp/manifest` from each server in TOLLGATE_SERVERS.
 *
 * Env:
 *   TOLLGATE_SERVERS     comma-separated list of server base URLs to discover
 *                        (e.g. http://localhost:3401,http://localhost:3402)
 *   RPC_URL              Solana RPC (default: devnet)
 *   PAYER_WALLET         path to keypair JSON
 *   MAX_USDC_PER_CALL    refuse quotes above this (raw 6-decimal USDC units)
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
import { payAndCall, ManifestResponse, ManifestTool } from "@tollgate/sdk";

const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const SERVERS = (process.env.TOLLGATE_SERVERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX = new BN(process.env.MAX_USDC_PER_CALL ?? "10000");

if (SERVERS.length === 0) {
  console.error(
    "TOLLGATE_SERVERS is required (comma-separated base URLs of Tollgate-wrapped servers exposing /mcp/manifest)"
  );
  process.exit(1);
}

function loadPayer(): Keypair {
  const p =
    process.env.PAYER_WALLET ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))
  );
}

const payer = loadPayer();
const connection = new Connection(RPC_URL, "confirmed");

console.error(
  JSON.stringify({
    msg: "tollgate-mcp starting",
    rpc: RPC_URL,
    servers: SERVERS,
    payer: payer.publicKey.toBase58(),
    maxUsdcPerCall: MAX.toString(),
  })
);

interface RegisteredTool extends ManifestTool {
  base: string;
}

async function discoverTools(): Promise<RegisteredTool[]> {
  const all: RegisteredTool[] = [];
  for (const base of SERVERS) {
    const url = `${base.replace(/\/$/, "")}/mcp/manifest`;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        console.error(
          JSON.stringify({ msg: "manifest fetch failed", url, status: r.status })
        );
        continue;
      }
      const body = (await r.json()) as ManifestResponse;
      if (body.version !== 1) {
        console.error(
          JSON.stringify({ msg: "unsupported manifest version", url, version: body.version })
        );
        continue;
      }
      for (const t of body.tools) {
        all.push({ ...t, base: base.replace(/\/$/, "") });
      }
      console.error(
        JSON.stringify({
          msg: "manifest loaded",
          url,
          tools: body.tools.map((t) => `${t.name}@${t.amount}`),
        })
      );
    } catch (e) {
      console.error(
        JSON.stringify({ msg: "manifest fetch error", url, error: String(e) })
      );
    }
  }

  // Detect duplicate tool names across servers — first one wins, log the rest.
  const seen = new Set<string>();
  const deduped: RegisteredTool[] = [];
  for (const t of all) {
    if (seen.has(t.name)) {
      console.error(
        JSON.stringify({ msg: "duplicate tool name dropped", name: t.name, base: t.base })
      );
      continue;
    }
    seen.add(t.name);
    deduped.push(t);
  }
  return deduped;
}

let TOOLS: RegisteredTool[] = [];

const server = new Server(
  { name: "tollgate-mcp", version: "0.2.0" },
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
        { type: "text", text: `tollgate-mcp error: ${(err as Error).message}` },
      ],
    };
  }
});

async function main() {
  TOOLS = await discoverTools();
  if (TOOLS.length === 0) {
    console.error("No tools discovered — exiting.");
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  console.error(
    JSON.stringify({ msg: "tollgate-mcp ready", tools: TOOLS.map((t) => t.name) })
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: "tollgate-mcp fatal", error: String(e) }));
  process.exit(1);
});
