# Tollgate Manifest Spec — v1

How a paid HTTP server advertises its tools to MCP shims (or any agent runtime that wants auto-discovery), so the agent can call them without hand-coded integration per API.

## Why

A Tollgate-wrapped server hosts paid tools. Without a manifest, every agent runtime needs hand-coded knowledge of which tools exist, what they cost, and what their input schemas look like. With a manifest, the agent runtime points at a list of server URLs, fetches one document per server on startup, and exposes every declared tool to the agent transparently.

This means the *server author* — not the *agent author* — controls what's exposed and at what price. New tools and price changes ship by deploying the server, no client coordination.

## The endpoint

Any Tollgate-wrapped server SHOULD expose:

```
GET /mcp/manifest
Content-Type: application/json
```

Response body, schema version 1:

```json
{
  "server": "242LjwZhEsQ1khYQtskCNdNLMtJS9iRT9jx6UGBJxKPe",
  "version": 1,
  "tools": [
    {
      "name": "openai_chat",
      "description": "Paid OpenAI chat via Tollgate. Refunds on OpenAI 5xx / 429 / parse error.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" },
          "model": { "type": "string" }
        },
        "required": ["prompt"]
      },
      "endpoint": "/tools/openai_chat",
      "endpointId": "tool:openai-chat-v1",
      "amount": "20000",
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "network": "solana-devnet"
    }
  ]
}
```

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `server` | base58 pubkey | yes | The on-chain pubkey that will claim/refund escrows |
| `version` | int | yes | Manifest schema version. Currently `1` |
| `tools[]` | array | yes | Zero or more paid tools |
| `tools[].name` | string | yes | MCP tool name surfaced to the agent. Must be unique within the manifest |
| `tools[].description` | string | yes | Human-readable, surfaced to the agent |
| `tools[].inputSchema` | JSON Schema | yes | Same shape as MCP `inputSchema` — an object schema with `properties` and `required` |
| `tools[].endpoint` | path | yes | HTTP path on this server, relative to the manifest URL's origin |
| `tools[].endpointId` | string | yes | Stable per-endpoint id used in nonce derivation. Changing it invalidates outstanding escrow proofs against this endpoint. Convention: `tool:<name>-vN` |
| `tools[].amount` | string (uint64) | yes | Quoted price in raw mint units. Must match what the server's `wrapTool` was configured with |
| `tools[].mint` | base58 pubkey | yes | SPL mint to settle in (e.g. devnet test USDC) |
| `tools[].network` | enum | yes | `solana-devnet` or `solana-mainnet` |

## Conformance

A Tollgate manifest is conformant if:

- The endpoint returns a JSON document matching the schema above.
- Every declared tool's actual `wrapTool` configuration uses the same `endpointId`, `amount`, `mint`, and `network` as advertised.
- A `POST` to `tools[].endpoint` with no `X-PAYMENT` header returns `402 Payment Required` with terms matching the manifest entry (verifiable via the existing x402 flow).

The manifest is **advisory**, not enforced on-chain. A misconfigured server (manifest disagrees with `wrapTool`) will simply fail `verifyPayment` checks at call time and either return 500 (refunded) or hang on a malformed proof.

## Client behavior (MCP shim)

The reference shim ([mcp/](./mcp/)) takes `TOLLGATE_SERVERS` as a comma-separated list of base URLs:

```bash
TOLLGATE_SERVERS=https://my-openai.example,https://my-brave.example,https://my-helius.example
```

On startup, it:

1. Fetches `${base}/mcp/manifest` for each server (in order).
2. Skips servers whose manifest fails to load or returns an unsupported `version`.
3. Concatenates all `tools[]` from all manifests.
4. On duplicate `name`, the first occurrence wins; later ones are dropped (logged to stderr).
5. Registers each surviving tool with the MCP server it serves, so MCP `tools/list` returns them.
6. On `tools/call`, the shim opens an endpoint-bound escrow (per the manifest's `amount` and the server-issued `endpointId`) and calls the endpoint with `X-PAYMENT`.

## Adding your own paid API

Any HTTP server using `wrapTool` from `@tollgate/sdk` can become Tollgate-discoverable by adding a `/mcp/manifest` route. The minimal diff for an existing express server:

```ts
import { ManifestResponse } from "@tollgate/sdk";

app.get("/mcp/manifest", (_req, res) => {
  const body: ManifestResponse = {
    server: serverWallet.publicKey.toBase58(),
    version: 1,
    tools: [
      {
        name: "my_tool",
        description: "What my paid tool does",
        inputSchema: { type: "object", properties: { ... }, required: [...] },
        endpoint: "/tools/my_tool",
        endpointId: "tool:my-tool-v1",
        amount: "5000",
        mint: USDC.toBase58(),
        network: "solana-devnet",
      },
    ],
  };
  res.json(body);
});
```

That's it. Add your server URL to your agent's `TOLLGATE_SERVERS`, restart, and the tool is callable.

## Versioning

This is `version: 1`. Future versions may add fields (e.g. per-tool deadlines, multi-mint pricing, schema for output, server attestation/signature). Clients must check `version` and skip manifests they don't understand rather than guessing.

## Out of scope (today)

- **Discovery beyond explicit URLs.** v1 has no DNS / DHT / on-chain registry — the agent has to know the server URL. A v2 registry could let agents discover Tollgate servers from a single index.
- **Authentication of the manifest itself.** Anyone can serve a `/mcp/manifest`; nothing on-chain proves the manifest came from the server's claimed pubkey. v2 could sign the manifest with the server keypair.
- **Output schema declarations.** v1 only specifies input schema. Output is whatever the handler returns.
