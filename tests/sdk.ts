import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

import {
  TollgateClient,
  build402,
  payAndProve,
  verifyPayment,
  deriveNonce,
  wrapTool,
  PaymentProof,
} from "../sdk/src";

describe("tollgate SDK — endpoint binding", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  let mint: PublicKey;
  let payer: Keypair;
  let server: Keypair;
  let payerAta: PublicKey;
  let serverAta: PublicKey;
  let client: TollgateClient;

  const fund = async (kp: Keypair, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(
      kp.publicKey,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  };

  before(async () => {
    payer = Keypair.generate();
    server = Keypair.generate();
    await fund(payer);
    await fund(server);

    const mintAuthority = Keypair.generate();
    await fund(mintAuthority);
    mint = await createMint(
      provider.connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6
    );

    payerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      payer.publicKey
    );
    serverAta = await createAssociatedTokenAccount(
      provider.connection,
      server,
      mint,
      server.publicKey
    );

    await mintTo(
      provider.connection,
      mintAuthority,
      mint,
      payerAta,
      mintAuthority,
      1_000_000_000
    );

    client = TollgateClient.withWallet(provider.connection, payer);
  });

  it("deriveNonce is deterministic per (endpointId, callId)", () => {
    const a = deriveNonce("tool:search-v1", "deadbeef");
    const b = deriveNonce("tool:search-v1", "deadbeef");
    expect(a.toString()).to.eq(b.toString());
  });

  it("deriveNonce differs across endpointIds", () => {
    const a = deriveNonce("tool:search-v1", "deadbeef");
    const b = deriveNonce("tool:rerank-v1", "deadbeef");
    expect(a.toString()).to.not.eq(b.toString());
  });

  it("verifyPayment accepts a proof bound to the same endpoint", async () => {
    const required = build402({
      programId: client.programId,
      server: server.publicKey,
      mint,
      amount: new BN(1_000),
      network: "solana-devnet",
      endpointId: "tool:search-v1",
    });

    const { proof } = await payAndProve({
      required,
      payer,
      connection: provider.connection,
    });

    const escrow = await verifyPayment(client, required, proof);
    expect(escrow).to.exist;
  });

  it("verifyPayment rejects a proof opened for a different endpoint", async () => {
    const requiredA = build402({
      programId: client.programId,
      server: server.publicKey,
      mint,
      amount: new BN(1_000),
      network: "solana-devnet",
      endpointId: "tool:search-v1",
    });

    const { proof } = await payAndProve({
      required: requiredA,
      payer,
      connection: provider.connection,
    });

    // Same server + mint + amount, but a different endpointId. The on-chain
    // nonce was derived from "tool:search-v1"; recomputing with another
    // endpointId yields a different value, so verifyPayment must reject.
    const requiredB = { ...requiredA, endpointId: "tool:rerank-v1" };

    let threw: Error | null = null;
    try {
      await verifyPayment(client, requiredB, proof);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw, "expected verifyPayment to reject cross-endpoint proof").to.exist;
    expect(threw!.message).to.match(/nonce mismatch|not bound/);
  });

  it("verifyPayment rejects a malformed callId", async () => {
    const required = build402({
      programId: client.programId,
      server: server.publicKey,
      mint,
      amount: new BN(1_000),
      network: "solana-devnet",
      endpointId: "tool:search-v1",
    });
    const { proof } = await payAndProve({
      required,
      payer,
      connection: provider.connection,
    });

    const bad: PaymentProof = { ...proof, callId: "not-hex-!!!" };
    let threw: Error | null = null;
    try {
      await verifyPayment(client, required, bad);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).to.exist;
    expect(threw!.message).to.match(/malformed callId/);
  });

  it("wrapTool blocks a parallel second call against the same escrow", async () => {
    let resolveHandler: ((v: { ok: true }) => void) | null = null;
    const slowHandler = () =>
      new Promise<{ ok: true }>((resolve) => {
        resolveHandler = resolve;
      });

    const tool = wrapTool(slowHandler, {
      endpointId: "tool:slow-v1",
      connection: provider.connection,
      serverWallet: server,
      mint,
      amount: new BN(1_500),
      network: "solana-devnet",
    });

    // Step 1: get a 402 quote
    const quote = await tool.serve(undefined, null);
    expect(quote.kind).to.eq("402");
    if (quote.kind !== "402") throw new Error("unreachable");

    // Step 2: client opens an escrow
    const { proof } = await payAndProve({
      required: quote.body,
      payer,
      connection: provider.connection,
    });
    const header = JSON.stringify(proof);

    // Step 3: fire two parallel serve() calls with the same proof.
    // The first should win (eventually returning ok), the second should be
    // rejected with kind: "in_use" without ever invoking the handler.
    const first = tool.serve(undefined, header);

    // Give the first call a moment to register itself in the in-flight set
    await new Promise((r) => setTimeout(r, 100));

    const second = await tool.serve(undefined, header);
    expect(second.kind).to.eq("in_use");

    // Now let the first call complete
    resolveHandler!({ ok: true });
    const firstResult = await first;
    expect(firstResult.kind).to.eq("ok");
  });
});
