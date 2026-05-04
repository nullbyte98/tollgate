# Tollgate

**Refundable x402 escrow primitive for Solana.** Pay-on-success agent calls — every paid tool call is held in an on-chain escrow that releases on success or refunds on failure / timeout.

The wedge over [mcpay](https://mcpay.tech) and [latinum](https://www.latinum.ai/): they charge upfront. If a paid agent tool returns garbage or times out, the agent loses the money. Tollgate holds the payment in escrow until the server proves delivery, and refunds automatically otherwise.

```
┌────────┐  402 Payment Required  ┌─────────┐
│ client │ ─────────────────────► │ server  │
│ (agent)│ ◄───────────────────── │ (tool)  │
└────────┘    payment terms       └─────────┘
     │
     │ open_escrow(amount, deadline, server)
     ▼
┌─────────────────┐
│ Escrow PDA      │  ◄── claim(receipt)            on success
│ vault: USDC     │  ◄── refund_by_server()        on detected failure
│ status: Open    │  ◄── refund_timeout() (anyone) after deadline
└─────────────────┘
```

## Layout

```
tollgate/
├── programs/tollgate/   Anchor program (4 instructions, 1 account)
├── tests/               Integration tests (8/8 passing)
├── sdk/                 TypeScript SDK: TollgateClient, wrapTool, payAndCall
├── server/              Demo HTTP server with 2 paid endpoints
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
  { connection, serverWallet, mint: USDC, amount: new BN(1_000), network: "solana-devnet" }
);

// in your HTTP / MCP handler:
const result = await tool.serve(input, req.header("X-PAYMENT"));
// result.kind === "402" | "ok" | "error"
//   "402"   → respond 402 with result.body
//   "ok"    → respond 200 with result.output (claim already submitted with response hash)
//   "error" → respond 500 (handler threw — payer auto-refunded)

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
anchor build && anchor test          # 8/8 passing

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
```

## What this is and isn't

**Is:** a primitive other people build on. The trust layer beneath x402 paywalls.

**Isn't:** a marketplace, a wallet, a hosted service. Self-host the demo server, plug `wrapTool` into your own MCP / HTTP / MCP-over-stdio handler.

## Status

Devnet program: `GnBmtnw4kpxDK2vswPLYyuiW2ysb32BUh7aTXpeX8kpb` (replace with your own keypair before deploy).
