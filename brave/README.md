# @tollgate/brave

**Brave Search MCP tools, gated by Tollgate's escrow paywall.**

Forked from the official MCP Brave Search server ([modelcontextprotocol/servers-archived/src/brave-search](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search), MIT). Two changes from upstream:

1. **HTTP, not stdio.** Each tool is a POST endpoint, not an MCP method. The MCP transport lives in [`../mcp`](../mcp/) and treats this as a paid HTTP backend.
2. **Each tool is wrapped with `wrapTool` from `@tollgate/sdk`.** A successful Brave call settles an on-chain escrow with a SHA-256 receipt of the response. A Brave 5xx, rate-limit, or parse error throws → wrapTool calls `refund_by_server` automatically.

## Why this matters

Brave Search costs money. Their official MCP server is a free-to-call wrapper that assumes you've signed up, given a credit card, and trust the server with your API key. There's no concept of per-call payment, no refund if Brave 5xxs, no way for an autonomous agent to consume it without out-of-band billing.

This fork makes it a **machine-payable, refundable** tool: an agent calls `brave_web_search`, Tollgate locks 0.005 USDC in escrow, the call runs, and either the escrow claims (Brave returned results) or refunds (Brave failed). No accounts, no chargebacks, no support tickets.

## Endpoints

| Endpoint | Price | Backed by |
|---|---|---|
| `POST /tools/brave_web_search` | 0.005 USDC | Brave Web Search REST API |
| `POST /tools/brave_local_search` | 0.008 USDC | Brave Local Search (POIs + descriptions) |

Both endpoints follow the standard Tollgate flow: first call returns 402 with terms; client opens an escrow; client retries with `X-PAYMENT` header. See [../README.md](../README.md) for the full protocol.

## Run

```bash
yarn install && yarn build

RPC_URL=https://api.devnet.solana.com \
  NETWORK=solana-devnet \
  MINT=<your-devnet-USDC-mint> \
  SERVER_WALLET=/path/to/server.json \
  PORT=3402 \
  BRAVE_API_KEY=<optional — get one at https://brave.com/search/api> \
  yarn start
```

If `BRAVE_API_KEY` is absent, both endpoints return clearly-tagged `[mock]` results so the demo flow works without signing up. The escrow + refund mechanics are identical either way — the difference is whether the `output` is real Brave data or mock data.

## Use from the MCP shim

```bash
TOLLGATE_BRAVE_URL=http://localhost:3402 \
  TOLLGATE_SERVER_URL=http://localhost:3401 \
  PAYER_WALLET=/path/to/payer.json \
  RPC_URL=https://api.devnet.solana.com \
  node ../mcp/dist/index.js
```

When `TOLLGATE_BRAVE_URL` is set, the MCP shim exposes `brave_web_search` and `brave_local_search` to Claude alongside the other tools.

## Attribution

Tool definitions and the rate-limit/POI-lookup logic in [`src/brave.ts`](./src/brave.ts) are derived from [@modelcontextprotocol/server-brave-search](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search) (MIT, © Anthropic).
