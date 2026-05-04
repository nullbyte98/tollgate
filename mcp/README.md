# @tollgate/mcp

Stdio MCP server that lets any MCP-speaking agent (Claude Desktop, custom MCP clients, etc.) call paid HTTP tools through Tollgate's escrow paywall.

```
┌─────────────────┐  stdio MCP   ┌──────────────┐  HTTP+x402  ┌──────────────────┐
│ Claude Desktop  │ ──────────── │ tollgate-mcp │ ─────────── │ tollgate-server  │
│ (or any agent)  │              │ (this pkg)   │             │ (your endpoints) │
└─────────────────┘              └──────────────┘             └──────────────────┘
                                        │
                                        │ payAndCall (auto opens escrow)
                                        ▼
                                  ┌──────────────┐
                                  │ Solana       │
                                  │ Tollgate PDA │
                                  └──────────────┘
```

The agent has no idea it's paying. From the agent's perspective `web_search(q)` just returns results. Under the hood the shim sees a `402 Payment Required`, opens an endpoint-bound escrow on Solana, retries with `X-PAYMENT`, and surfaces the on-chain settlement (escrow address + claim signature) back to the agent as a tool-result footer.

## Requires

- A running [tollgate-server](../server) (or any HTTP server that wraps endpoints with `wrapTool` from `@tollgate/sdk`).
- A funded payer keypair (devnet SOL + the SPL mint your server quotes prices in).

## Run standalone (smoke)

```bash
# in /server: start the demo HTTP server first
RPC_URL=https://api.devnet.solana.com \
  MINT=<your-mint> \
  SERVER_WALLET=/path/to/server.json \
  PORT=3401 yarn start

# in /mcp: drive the shim with a synthetic MCP client
RPC_URL=https://api.devnet.solana.com \
  PAYER_WALLET=/path/to/payer.json \
  TOLLGATE_SERVER_URL=http://localhost:3401 \
  yarn tsx src/smoke.ts
```

Expected: tools/list returns `web_search` + `rerank`. tools/call against `web_search` succeeds and returns results plus `_paid via tollgate escrow …_`. tools/call against `rerank` with `failMode: true` returns an error and the on-chain escrow status flips to `refunded`.

## Wire into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tollgate": {
      "command": "node",
      "args": ["/absolute/path/to/tollgate/mcp/dist/index.js"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "PAYER_WALLET": "/absolute/path/to/payer.json",
        "TOLLGATE_SERVER_URL": "https://your-deployed-tollgate-server.example",
        "MAX_USDC_PER_CALL": "10000"
      }
    }
  }
}
```

Restart Claude Desktop. In any chat: *"search the web for solana x402"* — Claude will pick `web_search`, the shim opens an escrow on devnet, your server claims it, results come back. Open https://tollgate-dapp.vercel.app side-by-side with your payer pubkey to watch the escrow appear in real time.

## Adding more tools

Edit the `TOOLS` array in [src/index.ts](./src/index.ts). Each entry is `{ name, description, inputSchema, endpoint }`. The shim treats the HTTP server as the source of truth for prices (each endpoint's `wrapTool` defines the amount and `endpointId`). To add a Brave Search tool, drop a `/tools/brave-search` endpoint in your server (wrapped with `wrapTool({ endpointId: "tool:brave-search-v1", ... })`), then add the corresponding entry here.

## Trust + spending controls

- `MAX_USDC_PER_CALL` — refuses any 402 quote above this many raw USDC units. Hard ceiling per call.
- The shim does not cache proofs or retry — one open escrow per call attempt.
- See [../TRUST.md](../TRUST.md) for the broader trust model. Important: the chain enforces who/when/how-much, not response correctness.
