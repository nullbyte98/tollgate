/**
 * Tollgate Manifest spec — how a paid HTTP server advertises its tools to
 * MCP shims (or any agent runtime that wants auto-discovery).
 *
 * A Tollgate-wrapped server SHOULD expose `GET /mcp/manifest` returning a
 * JSON body conforming to ManifestResponse below. The MCP shim fetches this
 * once on startup and dynamically registers each declared tool.
 */

export interface ManifestTool {
  /** MCP tool name surfaced to the agent (e.g. "openai_chat"). */
  name: string;
  /** Human-readable description, surfaced to the agent. */
  description: string;
  /** JSON Schema for tool input — same shape as MCP `inputSchema`. */
  inputSchema: Record<string, unknown>;
  /** HTTP path on this server, relative to the manifest URL's origin. */
  endpoint: string;
  /** Stable per-endpoint id used in nonce derivation (`tool:<name>-vN`). */
  endpointId: string;
  /** Quoted price in raw mint units (e.g. "5000" = 0.005 USDC at 6 decimals). */
  amount: string;
  /** SPL mint base58, e.g. devnet test USDC. */
  mint: string;
  /** Network the server settles on. */
  network: "solana-devnet" | "solana-mainnet";
}

export interface ManifestResponse {
  /** Server identity (the on-chain pubkey that will claim/refund escrows). */
  server: string;
  /** Schema version of this manifest. Currently 1. */
  version: 1;
  tools: ManifestTool[];
}
