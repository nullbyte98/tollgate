import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Tollgate } from "../target/types/tollgate";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";

const ESCROW_SEED = Buffer.from("escrow");
const VAULT_SEED = Buffer.from("vault");

const nonceBuf = (nonce: BN) => nonce.toArrayLike(Buffer, "le", 8);

const escrowPda = (
  programId: PublicKey,
  payer: PublicKey,
  server: PublicKey,
  nonce: BN
) =>
  PublicKey.findProgramAddressSync(
    [ESCROW_SEED, payer.toBuffer(), server.toBuffer(), nonceBuf(nonce)],
    programId
  )[0];

const vaultPda = (programId: PublicKey, escrow: PublicKey) =>
  PublicKey.findProgramAddressSync([VAULT_SEED, escrow.toBuffer()], programId)[0];

describe("tollgate", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.tollgate as Program<Tollgate>;

  let mint: PublicKey;
  let payer: Keypair;
  let server: Keypair;
  let payerAta: PublicKey;
  let serverAta: PublicKey;

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
  });

  const openEscrow = async (nonce: BN, amount: BN, deadline: BN) => {
    const escrow = escrowPda(program.programId, payer.publicKey, server.publicKey, nonce);
    const vault = vaultPda(program.programId, escrow);

    await program.methods
      .openEscrow(amount, deadline, nonce)
      .accountsPartial({
        payer: payer.publicKey,
        server: server.publicKey,
        mint,
        escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    return { escrow, vault };
  };

  it("happy path: open + claim transfers full amount to server", async () => {
    const nonce = new BN(1);
    const amount = new BN(1_000_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    const vaultBefore = await getAccount(provider.connection, vault);
    expect(vaultBefore.amount.toString()).to.eq(amount.toString());

    const serverBefore = await getAccount(provider.connection, serverAta);

    const receipt = Buffer.from("sha256-mocked-response-hash", "utf8");
    await program.methods
      .claim(receipt)
      .accountsPartial({
        server: server.publicKey,
        escrow,
        vault,
        serverTokenAccount: serverAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([server])
      .rpc();

    const serverAfter = await getAccount(provider.connection, serverAta);
    expect((serverAfter.amount - serverBefore.amount).toString()).to.eq(
      amount.toString()
    );

    const acc = await program.account.escrow.fetch(escrow);
    expect(acc.status).to.deep.eq({ claimed: {} });
    expect(acc.receiptLen).to.eq(receipt.length);
    expect(
      Buffer.from(acc.receipt.slice(0, acc.receiptLen)).toString("utf8")
    ).to.eq("sha256-mocked-response-hash");
  });

  it("refund_timeout: anyone can crank after deadline", async () => {
    const nonce = new BN(2);
    const amount = new BN(500_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 2);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    const payerBefore = await getAccount(provider.connection, payerAta);

    await new Promise((r) => setTimeout(r, 4000));

    const cranker = Keypair.generate();
    await fund(cranker);

    await program.methods
      .refundTimeout()
      .accountsPartial({
        cranker: cranker.publicKey,
        escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([cranker])
      .rpc();

    const payerAfter = await getAccount(provider.connection, payerAta);
    expect((payerAfter.amount - payerBefore.amount).toString()).to.eq(
      amount.toString()
    );

    const acc = await program.account.escrow.fetch(escrow);
    expect(acc.status).to.deep.eq({ refunded: {} });
  });

  it("refund_by_server: server self-refunds pre-deadline", async () => {
    const nonce = new BN(3);
    const amount = new BN(750_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    const payerBefore = await getAccount(provider.connection, payerAta);

    await program.methods
      .refundByServer()
      .accountsPartial({
        server: server.publicKey,
        escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([server])
      .rpc();

    const payerAfter = await getAccount(provider.connection, payerAta);
    expect((payerAfter.amount - payerBefore.amount).toString()).to.eq(
      amount.toString()
    );

    const acc = await program.account.escrow.fetch(escrow);
    expect(acc.status).to.deep.eq({ refunded: {} });
  });

  it("rejects open with zero amount", async () => {
    try {
      await openEscrow(
        new BN(4),
        new BN(0),
        new BN(Math.floor(Date.now() / 1000) + 3600)
      );
      expect.fail("expected InvalidAmount");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidAmount/);
    }
  });

  it("rejects open with past deadline", async () => {
    try {
      await openEscrow(
        new BN(5),
        new BN(1_000),
        new BN(Math.floor(Date.now() / 1000) - 60)
      );
      expect.fail("expected InvalidDeadline");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidDeadline/);
    }
  });

  it("rejects claim after deadline", async () => {
    const nonce = new BN(6);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 2);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);
    await new Promise((r) => setTimeout(r, 4000));

    try {
      await program.methods
        .claim(Buffer.alloc(0))
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          serverTokenAccount: serverAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected AlreadyExpired");
    } catch (e: any) {
      expect(e.toString()).to.match(/AlreadyExpired/);
    }
  });

  it("rejects refund_timeout before deadline", async () => {
    const nonce = new BN(7);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);
    const cranker = Keypair.generate();
    await fund(cranker);

    try {
      await program.methods
        .refundTimeout()
        .accountsPartial({
          cranker: cranker.publicKey,
          escrow,
          vault,
          payerTokenAccount: payerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([cranker])
        .rpc();
      expect.fail("expected NotYetExpired");
    } catch (e: any) {
      expect(e.toString()).to.match(/NotYetExpired/);
    }
  });

  // ─── Adversarial cases ────────────────────────────────────────────────

  it("rejects claim by wrong server (has_one mismatch)", async () => {
    const nonce = new BN(20);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    const attacker = Keypair.generate();
    await fund(attacker);
    const attackerAta = await createAssociatedTokenAccount(
      provider.connection,
      attacker,
      mint,
      attacker.publicKey
    );

    try {
      await program.methods
        .claim(Buffer.alloc(0))
        .accountsPartial({
          server: attacker.publicKey,
          escrow,
          vault,
          serverTokenAccount: attackerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      expect.fail("expected has_one constraint failure");
    } catch (e: any) {
      // Anchor surfaces this as ConstraintHasOne / 2001
      expect(e.toString()).to.match(/has[_ ]?one|HasOne|ConstraintHasOne|2001/i);
    }
  });

  it("rejects claim into wrong-mint server token account", async () => {
    const nonce = new BN(21);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    // Mint a *different* SPL mint and an ATA for the server under that mint
    const otherMintAuthority = Keypair.generate();
    await fund(otherMintAuthority);
    const otherMint = await createMint(
      provider.connection,
      otherMintAuthority,
      otherMintAuthority.publicKey,
      null,
      6
    );
    const wrongMintServerAta = await createAssociatedTokenAccount(
      provider.connection,
      server,
      otherMint,
      server.publicKey
    );

    try {
      await program.methods
        .claim(Buffer.alloc(0))
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          serverTokenAccount: wrongMintServerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected mint constraint failure");
    } catch (e: any) {
      expect(e.toString()).to.match(/mint|Mint|ConstraintTokenMint|2014/i);
    }
  });

  it("rejects claim after refund", async () => {
    const nonce = new BN(22);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    await program.methods
      .refundByServer()
      .accountsPartial({
        server: server.publicKey,
        escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([server])
      .rpc();

    try {
      await program.methods
        .claim(Buffer.alloc(0))
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          serverTokenAccount: serverAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected NotOpen");
    } catch (e: any) {
      expect(e.toString()).to.match(/NotOpen/);
    }
  });

  it("rejects refund_by_server after claim", async () => {
    const nonce = new BN(23);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    await program.methods
      .claim(Buffer.alloc(0))
      .accountsPartial({
        server: server.publicKey,
        escrow,
        vault,
        serverTokenAccount: serverAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([server])
      .rpc();

    try {
      await program.methods
        .refundByServer()
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          payerTokenAccount: payerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected NotOpen");
    } catch (e: any) {
      expect(e.toString()).to.match(/NotOpen/);
    }
  });

  it("rejects oversized receipt (>64 bytes)", async () => {
    const nonce = new BN(24);
    const amount = new BN(100_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    try {
      await program.methods
        .claim(Buffer.alloc(65, 0xab))
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          serverTokenAccount: serverAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected ReceiptTooLong");
    } catch (e: any) {
      expect(e.toString()).to.match(/ReceiptTooLong/);
    }
  });

  it("rejects double-claim on same escrow", async () => {
    const nonce = new BN(8);
    const amount = new BN(200_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const { escrow, vault } = await openEscrow(nonce, amount, deadline);

    await program.methods
      .claim(Buffer.alloc(0))
      .accountsPartial({
        server: server.publicKey,
        escrow,
        vault,
        serverTokenAccount: serverAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([server])
      .rpc();

    try {
      await program.methods
        .claim(Buffer.alloc(0))
        .accountsPartial({
          server: server.publicKey,
          escrow,
          vault,
          serverTokenAccount: serverAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([server])
        .rpc();
      expect.fail("expected NotOpen");
    } catch (e: any) {
      expect(e.toString()).to.match(/NotOpen/);
    }
  });
});
