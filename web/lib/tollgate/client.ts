import {
  AnchorProvider,
  Program,
  Idl,
  BN,
  Wallet,
} from "@coral-xyz/anchor";
import { randomBytes } from "crypto";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { escrowPda, vaultPda } from "./pdas";
import idlJson from "./idl/tollgate.json";

export const TOLLGATE_PROGRAM_ID = new PublicKey(
  "GnBmtnw4kpxDK2vswPLYyuiW2ysb32BUh7aTXpeX8kpb"
);

export type EscrowStatus = "open" | "claimed" | "refunded";

export interface EscrowAccount {
  address: PublicKey;
  payer: PublicKey;
  server: PublicKey;
  mint: PublicKey;
  amount: BN;
  deadline: BN;
  openedAt: BN;
  settledAt: BN;
  nonce: BN;
  status: EscrowStatus;
  receipt: Buffer;
}

function statusFromAnchor(s: any): EscrowStatus {
  if (s.open !== undefined) return "open";
  if (s.claimed !== undefined) return "claimed";
  if (s.refunded !== undefined) return "refunded";
  throw new Error(`unknown status: ${JSON.stringify(s)}`);
}

export class TollgateClient {
  readonly program: Program;
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(provider: AnchorProvider, programId: PublicKey = TOLLGATE_PROGRAM_ID) {
    this.connection = provider.connection;
    this.programId = programId;
    this.program = new Program(idlJson as Idl, provider);
  }

  static withWallet(
    connection: Connection,
    wallet: Keypair,
    programId: PublicKey = TOLLGATE_PROGRAM_ID
  ): TollgateClient {
    const provider = new AnchorProvider(connection, new Wallet(wallet), {
      commitment: "confirmed",
    });
    return new TollgateClient(provider, programId);
  }

  async openEscrow(params: {
    payer: Keypair;
    server: PublicKey;
    mint: PublicKey;
    amount: BN | bigint | number;
    deadline: BN | number;
    nonce?: BN | number;
  }): Promise<{ escrow: PublicKey; vault: PublicKey; signature: string; nonce: BN }> {
    const amount = new BN(params.amount.toString());
    const deadline = new BN(params.deadline.toString());
    const nonce =
      params.nonce !== undefined
        ? new BN(params.nonce.toString())
        : new BN(randomBytes(8), "le");

    const [escrow] = escrowPda(this.programId, params.payer.publicKey, params.server, nonce);
    const [vault] = vaultPda(this.programId, escrow);
    const payerAta = getAssociatedTokenAddressSync(params.mint, params.payer.publicKey);

    const signature = await this.program.methods
      .openEscrow(amount, deadline, nonce)
      .accountsPartial({
        payer: params.payer.publicKey,
        server: params.server,
        mint: params.mint,
        escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([params.payer])
      .rpc();

    return { escrow, vault, signature, nonce };
  }

  async claim(params: {
    server: Keypair;
    escrow: PublicKey;
    receipt?: Buffer | Uint8Array;
  }): Promise<string> {
    const acc = await this.fetchEscrow(params.escrow);
    const [vault] = vaultPda(this.programId, params.escrow);
    const serverAta = getAssociatedTokenAddressSync(acc.mint, params.server.publicKey);
    const receipt = params.receipt ? Buffer.from(params.receipt) : Buffer.alloc(0);

    return this.program.methods
      .claim(receipt)
      .accountsPartial({
        server: params.server.publicKey,
        escrow: params.escrow,
        vault,
        serverTokenAccount: serverAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([params.server])
      .rpc();
  }

  async refundTimeout(params: {
    cranker: Keypair;
    escrow: PublicKey;
  }): Promise<string> {
    const acc = await this.fetchEscrow(params.escrow);
    const [vault] = vaultPda(this.programId, params.escrow);
    const payerAta = getAssociatedTokenAddressSync(acc.mint, acc.payer);

    return this.program.methods
      .refundTimeout()
      .accountsPartial({
        cranker: params.cranker.publicKey,
        escrow: params.escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([params.cranker])
      .rpc();
  }

  async refundByServer(params: {
    server: Keypair;
    escrow: PublicKey;
  }): Promise<string> {
    const acc = await this.fetchEscrow(params.escrow);
    const [vault] = vaultPda(this.programId, params.escrow);
    const payerAta = getAssociatedTokenAddressSync(acc.mint, acc.payer);

    return this.program.methods
      .refundByServer()
      .accountsPartial({
        server: params.server.publicKey,
        escrow: params.escrow,
        vault,
        payerTokenAccount: payerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([params.server])
      .rpc();
  }

  async fetchEscrow(address: PublicKey): Promise<EscrowAccount> {
    const raw = await (this.program.account as any).escrow.fetch(address);
    return {
      address,
      payer: raw.payer,
      server: raw.server,
      mint: raw.mint,
      amount: raw.amount,
      deadline: raw.deadline,
      openedAt: raw.openedAt,
      settledAt: raw.settledAt,
      nonce: raw.nonce,
      status: statusFromAnchor(raw.status),
      receipt: Buffer.from(raw.receipt.slice(0, raw.receiptLen)),
    };
  }

  async listEscrowsForPayer(payer: PublicKey): Promise<EscrowAccount[]> {
    const accs = await (this.program.account as any).escrow.all([
      { memcmp: { offset: 8, bytes: payer.toBase58() } },
    ]);
    return accs.map((a: any) => ({
      address: a.publicKey,
      payer: a.account.payer,
      server: a.account.server,
      mint: a.account.mint,
      amount: a.account.amount,
      deadline: a.account.deadline,
      openedAt: a.account.openedAt,
      settledAt: a.account.settledAt,
      nonce: a.account.nonce,
      status: statusFromAnchor(a.account.status),
      receipt: Buffer.from(a.account.receipt.slice(0, a.account.receiptLen)),
    }));
  }

  async listEscrowsForServer(server: PublicKey): Promise<EscrowAccount[]> {
    const accs = await (this.program.account as any).escrow.all([
      { memcmp: { offset: 8 + 32, bytes: server.toBase58() } },
    ]);
    return accs.map((a: any) => ({
      address: a.publicKey,
      payer: a.account.payer,
      server: a.account.server,
      mint: a.account.mint,
      amount: a.account.amount,
      deadline: a.account.deadline,
      openedAt: a.account.openedAt,
      settledAt: a.account.settledAt,
      nonce: a.account.nonce,
      status: statusFromAnchor(a.account.status),
      receipt: Buffer.from(a.account.receipt.slice(0, a.account.receiptLen)),
    }));
  }
}
