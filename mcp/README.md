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

Expected: tools/list returns every tool from every server's `/mcp/manifest`. tools/call against any of them opens an escrow, runs the tool, and either claims (success) or auto-refunds (handler error).

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
        "TOLLGATE_SERVERS": "http://localhost:3401,http://localhost:3402,https://your-deployed-server.example",
        "MAX_USDC_PER_CALL": "100000"
      }
    }
  }
}
```

`TOLLGATE_SERVERS` is comma-separated. Each URL must serve `GET /mcp/manifest` per the [MANIFEST spec](../MANIFEST.md). Restart Claude Desktop. In any chat: *"search the web for solana x402"* — Claude picks the right tool from whichever server advertised it, the shim opens an escrow on devnet, server claims it, results come back. Open https://tollgate-dapp.vercel.app side-by-side with your payer pubkey to watch the escrow appear in real time.

## Adding more tools

You don't edit this shim. To add a new paid tool — say `helius_rpc` or your own SaaS — wrap it with `wrapTool` in any HTTP server, expose `GET /mcp/manifest` listing it (see [MANIFEST.md](../MANIFEST.md)), deploy that server, and add its URL to your `TOLLGATE_SERVERS` env. Restart Claude Desktop. The new tool appears in `tools/list` automatically.

## Trust + spending controls

- `MAX_USDC_PER_CALL` — refuses any 402 quote above this many raw USDC units. Hard ceiling per call.
- The shim does not cache proofs or retry — one open escrow per call attempt.
- See [../TRUST.md](../TRUST.md) for the broader trust model. Important: the chain enforces who/when/how-much, not response correctness.
