import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const ESCROW_SEED = Buffer.from("escrow");
export const VAULT_SEED = Buffer.from("vault");

const nonceBuf = (nonce: BN) => nonce.toArrayLike(Buffer, "le", 8);

export function escrowPda(
  programId: PublicKey,
  payer: PublicKey,
  server: PublicKey,
  nonce: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, payer.toBuffer(), server.toBuffer(), nonceBuf(nonce)],
    programId
  );
}

export function vaultPda(
  programId: PublicKey,
  escrow: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, escrow.toBuffer()],
    programId
  );
}
