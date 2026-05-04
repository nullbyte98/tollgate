# Trust Model

Tollgate is a **server-attested escrow** primitive. Read this before relying on it for non-trivial value.

## What the on-chain program enforces

- Funds are held in a vault PDA whose authority is the escrow PDA — neither the server nor the payer can move them outside the four allowed instructions.
- Only the named `server` (matched via Anchor `has_one`) can call `claim` or `refund_by_server`.
- `claim` is rejected if the escrow is not in `Open` state, if the deadline has passed, or if the receipt exceeds 64 bytes.
- `refund_timeout` is rejected before the deadline, but anyone may call it after.
- The state machine is one-shot: an escrow transitions `Open → Claimed | Refunded` exactly once.
- The transferred amount on settlement always equals the originally locked amount — no partial fills, no fee skim.

## What the program does **not** enforce

1. **Response correctness.** A successful `claim` means the server signed off, not that the response was useful. The 64-byte `receipt` field is opaque to the chain — the program does not verify that the response hashes to the stored receipt, nor that the response satisfies any schema.
2. **Server liveness.** A server can sit on an open escrow until the deadline. The payer's funds are locked until then; only after the deadline can anyone crank a refund.
3. **Server identity beyond a pubkey.** "Server X" is whatever pubkey the payer signs the escrow against. There is no on-chain reputation, slashing, or bond.
4. **Payment-to-response binding.** The proof returned by `payAndCall` is just the escrow address. The server verifies the escrow's terms match the quote, but a malicious client could try to reuse one escrow's proof against a different paid endpoint on the same server. Mitigations live in the SDK (server-side `verifyPayment` rebuilds the expected terms before claiming) but the chain alone does not prevent this.

## Threat model

| Actor | What they can do | What they can't do |
|---|---|---|
| Honest server, honest client | Settle in 1 tx pair | — |
| Malicious server, honest client | Claim against a garbage response (loss = quote price) | Steal more than `escrow.amount` per call. Claim after deadline. Drain a different escrow. |
| Honest server, malicious client | Refuse to pay (server returns 402, client never opens escrow). Open and abandon (server simply doesn't claim → funds locked until deadline). | Force-claim. Pull funds back before deadline. Replay a paid escrow against the same server twice. |
| Network observer | See all escrow accounts, parties, amounts (devnet/mainnet are public) | Forge claims/refunds. |
| MEV / front-runner | Front-run nothing useful — escrow PDAs are deterministic per `(payer, server, nonce)` so there's no race to claim a slot. | — |

## v1.1 (shipped) — endpoint binding via derived nonce

The on-chain escrow `nonce` is now deterministically derived as
`sha256("tollgate-endpoint-v1" || endpointId || callId)[..8]`. That has two
consequences:

1. A proof minted against `tool:search-v1` cannot be replayed against
   `tool:rerank-v1` even if both endpoints quote the same `(server, mint, amount)`
   — the recomputed nonce won't match the on-chain value. Verified in
   [`tests/sdk.ts`](./tests/sdk.ts).
2. `wrapTool` keeps an in-memory `Set` of in-flight escrow addresses and
   rejects a second concurrent `serve()` against the same proof with HTTP 409.
   This blocks the parallel-handler attack where one payment is racing two
   tools to "win" the work.

The binding is enforced by SDK code at the server. A server author who skips
`verifyPayment` is unprotected. v2 will move the binding into the program by
adding an explicit `endpoint_tag: [u8; 32]` field to the Escrow account.

## v1.3 (shipped) — production-readiness scaffolding

- **Pluggable durable lock store.** `wrapTool` accepts a `lockStore: LockStore`
  that gates parallel handlers against the same escrow. Default
  `MemoryLockStore` is fine for single-process; for multi-instance / serverless
  / load-balanced deployments, drop in a Redis or Postgres adapter implementing
  the same interface. Lock TTL defaults to the escrow deadline, so a crashed
  process unwedges its own keys.
- **Separated execution timeout.** `wrapTool({ executionTimeoutMs })` aborts a
  runaway handler and triggers refund-by-server, independent of the on-chain
  payment deadline. Useful for slow LLM calls or hung upstream APIs.
- **Orphan cranker (`runCranker`).** A sidecar that scans for past-deadline
  Open escrows targeting a given server and cranks `refund_timeout`. Set
  `CRANK_ORPHANS=true` in the demo server to enable. Doesn't replace the
  on-chain timeout — just makes sure it actually gets exercised promptly.

## Roadmap (clean version)

### v1 — market-ready (shipped + planned)
- ✓ Endpoint binding via derived nonce
- ✓ Server-attested receipt hashes
- ✓ Server-self-refund on detected failure
- ✓ Permissionless timeout-refund
- ✓ Pluggable durable lock store
- ✓ SDK execution timeout (separate from payment deadline)
- ✓ Orphan cranker
- ✓ Manifest spec for tool auto-discovery (v1.2)
- ◯ On-chain `endpoint_tag` field (binding moves from SDK → program)
- ◯ Real production deployments of 2–3 paid APIs (Brave + OpenAI scaffolded;
  needs API keys + public hosting)
- ◯ Hosted gateway (escrow verification, claim/refund cranking, monitoring)
- ◯ Mainnet deployment after audit pass

### v2 — trust layer
- ◯ Client-confirmed settlement: payer co-signs or opens a dispute window
- ◯ Commit-reveal on receipts: response hash committed at open, revealed at claim
- ◯ Configurable separate deadlines on-chain: payment expiry, execution window,
  claim window
- ◯ Endpoint registry: public list of Tollgate-enabled APIs with metadata
- ◯ Reputation system: refund rate, claim rate, response latency per server

### v3 — protocol maturity
- ◯ Server staking / bonds with slashing on dispute
- ◯ External verifiers / oracles for response correctness
- ◯ Marketplace + discovery layer
- ◯ External security audit

## Recommended use today (v1.3)

- **Paid MCP tools where the worst case is bounded** (the agent loses one
  quote price, typically $0.001–$0.05 per call).
- **Reputation-backed servers** where off-chain identity is the trust anchor;
  Tollgate just makes timeouts and clean refunds automatic.
- **Single-process demos and hackathon submissions.** For multi-instance
  production, replace the default `MemoryLockStore`.

## Not recommended today

- High-value single calls (anything where losing the quote price would matter).
- Adversarial server contexts where the server has incentive to claim against
  bad responses and disappear.
- Anything that needs guaranteed response correctness without an off-chain
  reputation/identity layer.
- Mainnet without an audit pass.
