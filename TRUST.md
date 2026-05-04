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

## What v1 doesn't have (planned for v2)

- **Client confirmation step.** Today the server can claim unilaterally. v2 should let the payer either co-sign settlement or open a dispute window after the server claims.
- **Commit-reveal on receipts.** Today `receipt` is a server-only attestation. v2 could commit to the receipt at `open_escrow` and reveal at `claim`, or have the server commit a hash and the payer reveal a nonce after seeing the response.
- **Slashable bonds.** Today there is no economic punishment for a server that claims against bad responses. v2 could require server-staked collateral that gets slashed on dispute.
- **Mainnet deployment.** Devnet only as of writing. Mainnet requires an audit pass and the v2 dispute mechanism.

## Recommended use today

- **Paid MCP tools where the worst case is bounded** (the agent loses one quote price, ~$0.001–$0.01 per call).
- **Reputation-backed servers** where the server's off-chain identity is what the payer is trusting, and the on-chain escrow is just a way to enforce timeouts and clean refunds when the server itself opts in.
- **Demos of the x402 escrow pattern** for hackathons / research.

## Not recommended today

- High-value single calls (anything where losing the quote price would matter).
- Adversarial server contexts where the server has incentive to claim against bad responses and disappear.
- Anything that needs guaranteed correctness without an off-chain reputation/identity layer.
