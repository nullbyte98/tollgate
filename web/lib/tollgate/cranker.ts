/**
 * Orphan-escrow cranker.
 *
 * The on-chain `refund_timeout` instruction is permissionless: anyone can call
 * it for any escrow whose deadline has passed. In practice nobody bothers —
 * the payer's funds sit in the vault PDA until somebody pokes the program.
 *
 * `runCranker` scans for Open escrows targeting a given `serverPubkey` whose
 * `deadline` has elapsed, and cranks `refund_timeout` for each one. Run it as
 * a sidecar inside any Tollgate server, or as a standalone process for a
 * specific server identity. Every cranked escrow refunds the payer in one tx.
 *
 * This is a v1.x convenience layer, not a substitute for the on-chain
 * timeout — it just makes sure the timeout actually gets exercised promptly
 * when the server (or anyone else) crashes between `verifyPayment` and
 * `claim`/`refund`.
 */
import { PublicKey, Keypair } from "@solana/web3.js";
import { TollgateClient } from "./client";

export interface CrankerOptions {
  client: TollgateClient;
  /** The keypair that will pay tx fees for the crank. May be any funded wallet. */
  cranker: Keypair;
  /** Restrict to escrows targeting this server pubkey. */
  serverPubkey: PublicKey;
  /** How often to scan, in ms. Default 60_000 (1 min). */
  intervalMs?: number;
  /** Optional logger; defaults to console.log on stderr-friendly format. */
  log?: (msg: Record<string, unknown>) => void;
}

export interface CrankerHandle {
  stop(): void;
}

export function runCranker(opts: CrankerOptions): CrankerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const log =
    opts.log ?? ((m) => process.stderr.write(JSON.stringify(m) + "\n"));

  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const escrows = await opts.client.listEscrowsForServer(opts.serverPubkey);
      const now = Math.floor(Date.now() / 1000);
      const orphans = escrows.filter(
        (e) => e.status === "open" && e.deadline.toNumber() < now
      );

      if (orphans.length > 0) {
        log({ msg: "cranker: orphans found", count: orphans.length });
      }

      for (const e of orphans) {
        try {
          const sig = await opts.client.refundTimeout({
            cranker: opts.cranker,
            escrow: e.address,
          });
          log({
            msg: "cranker: refunded",
            escrow: e.address.toBase58(),
            payer: e.payer.toBase58(),
            amount: e.amount.toString(),
            signature: sig.slice(0, 16) + "...",
          });
        } catch (err) {
          log({
            msg: "cranker: refund failed",
            escrow: e.address.toBase58(),
            error: String(err),
          });
        }
      }
    } catch (err) {
      log({ msg: "cranker: tick failed", error: String(err) });
    }
  }

  // Fire immediately, then on interval
  void tick();
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
