/**
 * Server-side runtime config for the public Tollgate demo deployed on Vercel.
 *
 * Wallet keypairs are passed as base64-encoded JSON arrays in env vars so they
 * can live in Vercel's encrypted env. Decoded once per cold start.
 */
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";

export const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
export const NETWORK = (process.env.NETWORK ?? "solana-devnet") as
  | "solana-devnet"
  | "solana-mainnet";

export const MINT = new PublicKey(
  process.env.MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const BRAVE_API_KEY = process.env.BRAVE_API_KEY ?? null;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null;

function decodeKeypair(envName: string): Keypair {
  const v = process.env[envName];
  if (!v) {
    throw new Error(
      `${envName} is not set — base64-encoded JSON array of secret key bytes is required`
    );
  }
  const json = Buffer.from(v, "base64").toString("utf8");
  const arr = JSON.parse(json);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

let _server: Keypair | null = null;
let _payer: Keypair | null = null;

export function serverWallet(): Keypair {
  if (!_server) _server = decodeKeypair("SERVER_WALLET_B64");
  return _server;
}
export function demoPayerWallet(): Keypair {
  if (!_payer) _payer = decodeKeypair("DEMO_PAYER_WALLET_B64");
  return _payer;
}

export function makeConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}
