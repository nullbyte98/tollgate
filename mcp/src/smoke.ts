/**
 * Smoke test: spawns the manifest-discovering MCP shim, lists tools fetched
 * from each TOLLGATE_SERVERS entry, then exercises one tool from each server
 * (success path + auto-refund path).
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
      TOLLGATE_SERVERS:
        process.env.TOLLGATE_SERVERS ??
        "http://localhost:3401,http://localhost:3402",
      PAYER_WALLET:
        process.env.PAYER_WALLET ??
        "/Users/talal/Downloads/tollgate-keys/payer.json",
      MAX_USDC_PER_CALL: process.env.MAX_USDC_PER_CALL ?? "100000",
    },
  });

  const client = new Client(
    { name: "tollgate-mcp-smoke", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(transport);

  console.log("── tools/list (auto-discovered) ──");
  const list = await client.listTools();
  for (const t of list.tools) {
    console.log(`  ${t.name} — ${t.description?.slice(0, 70)}…`);
  }

  console.log("\n── web_search (success) ──");
  const r1 = await client.callTool({
    name: "web_search",
    arguments: { q: "tollgate manifest" },
  });
  for (const c of (r1.content as any[]) ?? []) console.log(c.text);

  console.log("\n── openai_chat (mock or real depending on OPENAI_API_KEY) ──");
  const r2 = await client.callTool({
    name: "openai_chat",
    arguments: { prompt: "say hi in one word" },
  });
  for (const c of (r2.content as any[]) ?? []) console.log(c.text);

  console.log("\n── brave_web_search (mock or real depending on BRAVE_API_KEY) ──");
  const r3 = await client.callTool({
    name: "brave_web_search",
    arguments: { query: "solana x402 tollgate", count: 2 },
  });
  for (const c of (r3.content as any[]) ?? []) console.log(c.text);

  console.log("\n── rerank failMode (auto-refund) ──");
  const r4 = await client.callTool({
    name: "rerank",
    arguments: { items: ["a", "b"], query: "x", failMode: true },
  });
  for (const c of (r4.content as any[]) ?? []) console.log(c.text);

  await client.close();
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
