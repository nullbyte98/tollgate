# Tollgate

**Refundable Solana escrow payments for paid tool calls.** Every paid agent/tool call is locked in an on-chain escrow. The server can claim it (with a self-attested receipt hash), the server can voluntarily refund it on a self-detected failure, or anyone can crank a refund back to the payer once the deadline passes. The chain does not verify response correctness — it enforces who can settle, when, and how much.

The wedge over [mcpay](https://mcpay.tech) and [latinum](https://www.latinum.ai/): they charge upfront. If a paid tool returns garbage, throws, or goes silent, the agent loses the money. Tollgate's primitive lets:

- the **server** voluntarily refund on a self-detected failure (e.g. upstream API 5xx), and
- **anyone** crank a refund back to the payer once the deadline passes if the server never claims.

> **Trust model — read this.** Tollgate is **server-attested**, not trustlessly verified. A successful `claim` means *the server signed off and recorded a receipt hash on-chain*, not that the response was correct. A malicious server can still claim against a garbage response. The honest framing: **escrowed payment with server-attested settlement and timeout fallback.** See [TRUST.md](./TRUST.md) for what's enforced vs. what's assumed.

**Endpoint binding (v1.1).** Each paid endpoint declares a stable `endpointId`. The on-chain escrow `nonce` is deterministically derived from `sha256("tollgate-endpoint-v1" || endpointId || callId)`, so a proof opened against endpoint A cannot be replayed against endpoint B even if both quote the same `(server, mint, amount)`. Plus `wrapTool` keeps an in-flight set of escrows in memory to block parallel-handler attacks (one payment, two tools racing to do the work). See [`tests/sdk.ts`](./tests/sdk.ts) for the adversarial cases.

**Auto-discovery via Tollgate Manifest (v1.2).** Any Tollgate-wrapped server exposes `GET /mcp/manifest` advertising its paid tools (name, schema, price, mint, endpointId). The MCP shim takes a `TOLLGATE_SERVERS` env var (comma-separated base URLs), fetches each manifest at startup, and dynamically registers every declared tool. **No code change to add a new paid API to your agent — deploy a server, add its URL to the env, restart Claude Desktop.** Spec at [MANIFEST.md](./MANIFEST.md). Worked examples in [server/](./server/) (mock search, rerank, OpenAI chat) and [brave/](./brave/) (forked Brave Search).

```
┌────────┐  402 Payment Required  ┌─────────┐
│ client │ ─────────────────────► │ server  │
│ (agent)│ ◄───────────────────── │ (tool)  │
└────────┘    payment terms       └─────────┘
     │
     │ open_escrow(amount, deadline, server)
     ▼
┌─────────────────┐
│ Escrow PDA      │  ◄── claim(receipt)            server attests success
│ vault: USDC     │  ◄── refund_by_server()        on detected failure
│ status: Open    │  ◄── refund_timeout() (anyone) after deadline
└─────────────────┘
```

## Layout

```
tollgate/
├── programs/tollgate/   Anchor program (4 instructions, 1 account)
├── tests/               Integration tests (19/19 passing — 13 program + 6 SDK)
├── sdk/                 TypeScript SDK: TollgateClient, wrapTool, payAndCall
├── server/              Demo HTTP server with 2 paid endpoints (mock search + rerank)
├── brave/               Forked from official MCP brave-search — paid Brave Search via Tollgate
├── mcp/                 Stdio MCP shim — lets Claude Desktop / any MCP agent call the paid endpoints
└── web/                 Next.js dashboard — live escrows by payer or server
```

## Program

PDA seeds:

- `Escrow`: `[b"escrow", payer, server, nonce_le_bytes]`
- `Vault`:  `[b"vault", escrow]` — token account, escrow PDA is the authority

State machine: `Open → Claimed | Refunded`. Status only transitions from `Open`; double-claims and double-refunds are rejected.

| instruction        | who can call             | when                        |
|--------------------|--------------------------|-----------------------------|
| `open_escrow`      | payer                    | always                      |
| `claim`            | server (`has_one`)       | status=Open, before deadline|
| `refund_by_server` | server (`has_one`)       | status=Open                 |
| `refund_timeout`   | anyone (cranker pays gas)| status=Open, after deadline |

The `claim` instruction records an optional 64-byte receipt — typically a SHA-256 of the served response — for off-chain verification.

## SDK

```ts
import { wrapTool, payAndCall } from "@tollgate/sdk";

// ── server side ──
const tool = wrapTool(
  async ({ q }: { q: string }) => ({ results: await search(q) }),
  {
    endpointId: "tool:search-v1", // REQUIRED — binds escrow to this endpoint via derived nonce
    connection,
    serverWallet,
    mint: USDC,
    amount: new BN(1_000),
    network: "solana-devnet",
  }
);

// in your HTTP / MCP handler:
const result = await tool.serve(input, req.header("X-PAYMENT"));
// result.kind === "402" | "ok" | "error" | "in_use"
//   "402"    → respond 402 with result.body
//   "ok"     → respond 200 with result.output (claim already submitted with response hash)
//   "error"  → respond 500 (handler threw — payer auto-refunded)
//   "in_use" → respond 409 (same proof already being processed by this server)

// ── client side ──
const { response, escrow } = await payAndCall({
  url: "https://my-mcp-server/tools/search",
  payer,
  connection,
  fetchInit: { method: "POST", body: JSON.stringify({ q: "solana x402" }) },
  maxAmount: new BN(10_000), // refuse if quoted price exceeds this
});
```

## Run

```bash
# 1. program
anchor build && anchor test          # 19/19 passing (13 program + 6 SDK)

# 2. demo server (paid /tools/search and /tools/rerank)
cd server && yarn build && \
  RPC_URL=https://api.devnet.solana.com \
  MINT=<your-devnet-USDC-mint> \
  yarn start

# 3. demo client — runs full pay → claim, then pay → refund
cd server && \
  SERVER_URL=http://localhost:3001 \
  RPC_URL=https://api.devnet.solana.com \
  yarn tsx src/demo-client.ts

# 4. dashboard
cd web && yarn dev
# open http://localhost:3000, paste a payer or server pubkey

# 5. MCP shim — let Claude Desktop call ALL paid endpoints from any servers
cd mcp && yarn build
# smoke test against multiple servers — auto-discovers tools via /mcp/manifest
RPC_URL=https://api.devnet.solana.com \
  PAYER_WALLET=/path/to/payer.json \
  TOLLGATE_SERVERS=http://localhost:3401,http://localhost:3402 \
  yarn tsx src/smoke.ts
# wire into Claude Desktop — see mcp/README.md for the exact config snippet
```

## What this is and isn't

**Is:** a primitive other people build on. The trust layer beneath x402 paywalls.

**Isn't:** a marketplace, a wallet, a hosted service. Self-host the demo server, plug `wrapTool` into your own MCP / HTTP / MCP-over-stdio handler.

## Status

Devnet program: `GnBmtnw4kpxDK2vswPLYyuiW2ysb32BUh7aTXpeX8kpb` (replace with your own keypair before deploy).
