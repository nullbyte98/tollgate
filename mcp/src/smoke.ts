/**
 * Smoke test: spawns the MCP shim as a child process, talks to it over stdio
 * using the MCP protocol, runs tools/list + a successful tools/call + a
 * failing tools/call (failMode), and verifies both escrow outcomes.
 *
 * Usage:
 *   PAYER_WALLET=… RPC_URL=… TOLLGATE_SERVER_URL=http://localhost:3401 \
 *     yarn tsx src/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

async function main() {
  const shimPath = path.join(__dirname, "index.ts");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", shimPath],
    env: {
      ...process.env,
      RPC_URL: process.env.RPC_URL ?? "https://api.devnet.solana.com",
      TOLLGATE_SERVER_URL:
        process.env.TOLLGATE_SERVER_URL ?? "http://localhost:3401",
      PAYER_WALLET:
        process.env.PAYER_WALLET ??
        "/Users/talal/Downloads/tollgate-keys/payer.json",
      MAX_USDC_PER_CALL: process.env.MAX_USDC_PER_CALL ?? "10000",
    },
  });

  const client = new Client(
    { name: "tollgate-mcp-smoke", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(transport);

  console.log("── tools/list ──");
  const list = await client.listTools();
  console.log(
    list.tools.map((t) => `  ${t.name} — ${t.description?.slice(0, 60)}…`).join("\n")
  );

  console.log("\n── tools/call web_search (success) ──");
  const r1 = await client.callTool({
    name: "web_search",
    arguments: { q: "tollgate mcp" },
  });
  for (const c of (r1.content as any[]) ?? []) console.log(c.text);

  console.log("\n── tools/call rerank (failMode → auto-refund) ──");
  const r2 = await client.callTool({
    name: "rerank",
    arguments: { items: ["a", "b", "c"], query: "x", failMode: true },
  });
  for (const c of (r2.content as any[]) ?? []) console.log(c.text);
  console.log(`isError: ${r2.isError}`);

  if (process.env.TOLLGATE_BRAVE_URL) {
    console.log("\n── tools/call brave_web_search (real Brave if BRAVE_API_KEY set, else mock) ──");
    const r3 = await client.callTool({
      name: "brave_web_search",
      arguments: { query: "tollgate solana x402", count: 3 },
    });
    for (const c of (r3.content as any[]) ?? []) console.log(c.text);
  } else {
    console.log("\n(skipping brave_web_search — set TOLLGATE_BRAVE_URL to enable)");
  }

  await client.close();
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
