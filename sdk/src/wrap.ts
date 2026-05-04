import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import BN from "bn.js";
import { TollgateClient } from "./client";
import {
  build402,
  verifyPayment,
  receiptHash,
  PaymentProof,
  PAYMENT_HEADER,
} from "./x402";

export interface ToolHandler<I, O> {
  (input: I): Promise<O>;
}

export interface WrappedTool<I, O> {
  /**
   * Run the tool through the Tollgate paywall.
   *
   * If `paymentHeader` is missing, returns `{ kind: "402", body }` — the caller
   * sends this as a 402 response.
   *
   * If present, verifies the escrow, runs the handler, claims on success
   * (with the response hash as receipt), and refunds on handler error.
   */
  serve(input: I, paymentHeader: string | null | undefined): Promise<
    | { kind: "402"; body: ReturnType<typeof build402> }
    | { kind: "ok"; output: O; escrow: PublicKey; signature: string }
    | { kind: "error"; error: Error; refundedEscrow?: PublicKey }
  >;
}

export interface WrapOptions {
  connection: Connection;
  serverWallet: Keypair;
  mint: PublicKey;
  amount: BN | bigint | number;
  programId?: PublicKey;
  network: "solana-devnet" | "solana-mainnet";
  deadlineSeconds?: number;
}

/**
 * Wrap a tool handler so it serves through Tollgate's escrow paywall.
 * On handler error, the server auto-refunds the payer — the wedge over mcpay/latinum.
 */
export function wrapTool<I, O>(
  handler: ToolHandler<I, O>,
  opts: WrapOptions
): WrappedTool<I, O> {
  const client = TollgateClient.withWallet(
    opts.connection,
    opts.serverWallet,
    opts.programId
  );

  return {
    async serve(input, paymentHeader) {
      const required = build402({
        programId: client.programId,
        server: opts.serverWallet.publicKey,
        mint: opts.mint,
        amount: opts.amount,
        network: opts.network,
        deadlineSeconds: opts.deadlineSeconds,
      });

      if (!paymentHeader) {
        return { kind: "402", body: required };
      }

      let proof: PaymentProof;
      try {
        proof = JSON.parse(paymentHeader);
      } catch {
        return { kind: "error", error: new Error("malformed X-PAYMENT header") };
      }

      const escrow = await verifyPayment(client, required, proof);

      try {
        const output = await handler(input);
        const receipt = receiptHash(output);
        const signature = await client.claim({
          server: opts.serverWallet,
          escrow,
          receipt,
        });
        return { kind: "ok", output, escrow, signature };
      } catch (err) {
        try {
          await client.refundByServer({ server: opts.serverWallet, escrow });
          return {
            kind: "error",
            error: err as Error,
            refundedEscrow: escrow,
          };
        } catch (refundErr) {
          return {
            kind: "error",
            error: new Error(
              `handler failed (${(err as Error).message}) and refund failed (${(refundErr as Error).message})`
            ),
          };
        }
      }
    },
  };
}

export { PAYMENT_HEADER };
