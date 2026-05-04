import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import BN from "bn.js";
import * as crypto from "crypto";
import { TollgateClient } from "./client";

/**
 * x402 Payment Required body returned by a Tollgate-protected MCP server.
 *
 * `endpointId` is what binds the escrow to *this* paid endpoint. The on-chain
 * nonce is derived deterministically from `endpointId` + a per-call nonce, so
 * a proof opened against endpoint A cannot be replayed against endpoint B
 * even if both endpoints quote the same (server, mint, amount).
 */
export interface PaymentRequired {
  scheme: "tollgate-x402";
  network: "solana-devnet" | "solana-mainnet";
  programId: string;
  server: string;
  mint: string;
  amount: string;
  deadlineSeconds: number;
  endpointId: string;
}

/**
 * Payment proof returned by the client and consumed by the server.
 *
 * - `escrow`: the on-chain escrow PDA address
 * - `callId`: random 8 bytes (hex) used by the client when deriving the on-chain
 *   nonce. The server uses this together with its own `endpointId` to recompute
 *   the expected nonce and compare it against `escrow.nonce`.
 *
 * We deliberately do NOT include the open-tx signature: the server doesn't
 * verify it, so including it would imply a check we don't actually perform.
 */
export interface PaymentProof {
  escrow: string;
  callId: string;
}

const HEADER = "X-PAYMENT";
const ENDPOINT_NONCE_DOMAIN = "tollgate-endpoint-v1";

/**
 * Deterministically derive the on-chain `nonce` u64 from the endpointId
 * and a per-call random tag. Identical inputs → identical nonce → identical
 * escrow PDA, so the binding lives in the PDA itself.
 */
export function deriveNonce(endpointId: string, callIdHex: string): BN {
  const h = crypto
    .createHash("sha256")
    .update(ENDPOINT_NONCE_DOMAIN)
    .update(":")
    .update(endpointId)
    .update(":")
    .update(callIdHex)
    .digest();
  // first 8 bytes, little-endian u64
  return new BN(h.subarray(0, 8), "le");
}

/**
 * Server-side: build a 402 response body for a given price + endpoint.
 */
export function build402(opts: {
  programId: PublicKey;
  server: PublicKey;
  mint: PublicKey;
  amount: BN | bigint | number;
  network: "solana-devnet" | "solana-mainnet";
  endpointId: string;
  deadlineSeconds?: number;
}): PaymentRequired {
  return {
    scheme: "tollgate-x402",
    network: opts.network,
    programId: opts.programId.toBase58(),
    server: opts.server.toBase58(),
    mint: opts.mint.toBase58(),
    amount: opts.amount.toString(),
    deadlineSeconds: opts.deadlineSeconds ?? 300,
    endpointId: opts.endpointId,
  };
}

/**
 * Server-side: verify the on-chain escrow exists, matches the expected
 * (server, mint, amount), is still Open, has not yet expired, **and** is
 * bound to this endpoint via its derived nonce.
 *
 * Returns the escrow address ready to be `claim()`ed after the tool runs.
 */
export async function verifyPayment(
  client: TollgateClient,
  expected: PaymentRequired,
  proof: PaymentProof
): Promise<PublicKey> {
  if (!proof.callId || !/^[0-9a-f]+$/i.test(proof.callId)) {
    throw new Error("missing or malformed callId");
  }
  const escrow = new PublicKey(proof.escrow);
  const acc = await client.fetchEscrow(escrow);

  if (acc.status !== "open") {
    throw new Error(`escrow not open: ${acc.status}`);
  }
  if (acc.server.toBase58() !== expected.server) {
    throw new Error("escrow server mismatch");
  }
  if (acc.mint.toBase58() !== expected.mint) {
    throw new Error("escrow mint mismatch");
  }
  if (acc.amount.toString() !== expected.amount) {
    throw new Error(
      `escrow amount mismatch: expected ${expected.amount}, got ${acc.amount}`
    );
  }
  const expectedNonce = deriveNonce(expected.endpointId, proof.callId);
  if (!acc.nonce.eq(expectedNonce)) {
    throw new Error(
      "escrow nonce mismatch — proof is not bound to this endpoint"
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (acc.deadline.toNumber() <= now) {
    throw new Error("escrow already expired");
  }

  return escrow;
}

/**
 * Compute a deterministic receipt hash to record on-chain when the server
 * claims. Lets payers verify off-chain that the response they received hashes
 * to what the server attested to.
 */
export function receiptHash(response: unknown): Buffer {
  const json =
    typeof response === "string" ? response : JSON.stringify(response);
  return crypto.createHash("sha256").update(json).digest().subarray(0, 32);
}

/**
 * Client-side: given a 402 response, open an escrow whose nonce is bound to
 * the quoted endpoint, and return the proof payload to inject into the
 * X-PAYMENT header on the retry.
 */
export async function payAndProve(opts: {
  required: PaymentRequired;
  payer: Keypair;
  connection: Connection;
}): Promise<{ proof: PaymentProof; escrow: PublicKey }> {
  const programId = new PublicKey(opts.required.programId);
  const server = new PublicKey(opts.required.server);
  const mint = new PublicKey(opts.required.mint);

  const client = TollgateClient.withWallet(opts.connection, opts.payer, programId);

  const deadline = Math.floor(Date.now() / 1000) + opts.required.deadlineSeconds;
  const callIdHex = crypto.randomBytes(16).toString("hex");
  const nonce = deriveNonce(opts.required.endpointId, callIdHex);

  const { escrow } = await client.openEscrow({
    payer: opts.payer,
    server,
    mint,
    amount: new BN(opts.required.amount),
    deadline,
    nonce,
  });

  return {
    escrow,
    proof: { escrow: escrow.toBase58(), callId: callIdHex },
  };
}

/**
 * Client-side: thin wrapper around fetch that handles a 402 response by
 * opening an endpoint-bound escrow and retrying with the X-PAYMENT proof.
 */
export async function payAndCall(opts: {
  url: string;
  payer: Keypair;
  connection: Connection;
  fetchInit?: RequestInit;
  maxAmount?: BN | bigint | number;
}): Promise<{ response: Response; escrow?: PublicKey }> {
  const first = await fetch(opts.url, opts.fetchInit);
  if (first.status !== 402) {
    return { response: first };
  }

  const required = (await first.json()) as PaymentRequired;
  if (required.scheme !== "tollgate-x402") {
    throw new Error(`unsupported payment scheme: ${required.scheme}`);
  }
  if (!required.endpointId) {
    throw new Error("402 body missing endpointId — cannot bind escrow safely");
  }
  if (opts.maxAmount !== undefined) {
    const max = new BN(opts.maxAmount.toString());
    if (new BN(required.amount).gt(max)) {
      throw new Error(
        `quoted price ${required.amount} exceeds maxAmount ${max.toString()}`
      );
    }
  }

  const { proof, escrow } = await payAndProve({
    required,
    payer: opts.payer,
    connection: opts.connection,
  });

  const headers = new Headers(opts.fetchInit?.headers);
  headers.set(HEADER, JSON.stringify(proof));
  const second = await fetch(opts.url, { ...opts.fetchInit, headers });
  return { response: second, escrow };
}

export const PAYMENT_HEADER = HEADER;
