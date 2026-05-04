"use client";

import { useState } from "react";

interface TryResult {
  kind: "claim" | "refund";
  payer: string;
  escrow: string | null;
  status: number;
  output?: any;
  error?: string;
  refundedEscrow?: string;
  claimSignature?: string;
}

export default function TryIt({
  onResult,
}: {
  onResult?: (r: TryResult) => void;
}) {
  const [pending, setPending] = useState<"claim" | "refund" | null>(null);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trigger = async (kind: "claim" | "refund") => {
    setPending(kind);
    setError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/demo/try?kind=${kind}`, { method: "POST" });
      const body = (await r.json()) as TryResult & { error?: string };
      if (r.ok) {
        setResult(body);
        onResult?.(body);
      } else {
        setError(body.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
  };

  const explorerUrl = (addr: string) =>
    `https://explorer.solana.com/address/${addr}?cluster=devnet`;

  return (
    <section
      style={{
        marginTop: 32,
        padding: 24,
        border: "1px solid #27272a",
        borderRadius: 12,
        background: "#111114",
      }}
    >
      <div style={{ marginBottom: 4, fontSize: 18, fontWeight: 600 }}>
        try it — one click, real escrow on devnet
      </div>
      <div
        style={{ marginBottom: 16, color: "#9ca3af", fontSize: 13, lineHeight: 1.5 }}
      >
        no wallet needed. our payer wallet opens a real escrow against the
        public Tollgate server, the tool runs, and the on-chain settlement
        flips live. paste the payer pubkey above (returned below) into
        &quot;as payer&quot; to see the new escrow appear in the list.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => trigger("claim")}
          disabled={pending !== null}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: pending === "claim" ? "#1e40af" : "#3b82f6",
            color: "white",
            cursor: pending !== null ? "wait" : "pointer",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {pending === "claim" ? "opening…" : "open a paid call (claims)"}
        </button>
        <button
          onClick={() => trigger("refund")}
          disabled={pending !== null}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #f59e0b",
            background:
              pending === "refund" ? "rgba(245,158,11,0.4)" : "transparent",
            color: pending === "refund" ? "white" : "#f59e0b",
            cursor: pending !== null ? "wait" : "pointer",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {pending === "refund"
            ? "opening…"
            : "trigger a failure (auto-refunds)"}
        </button>
      </div>

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "rgba(239,68,68,0.1)",
            color: "#ef4444",
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 8,
            background: "#0b0b0d",
            border: "1px solid #27272a",
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <span style={{ color: "#9ca3af" }}>kind: </span>
            <span style={{ color: result.kind === "claim" ? "#22c55e" : "#f59e0b", fontWeight: 600 }}>
              {result.kind}
            </span>
            {" · "}
            <span style={{ color: "#9ca3af" }}>http: </span>
            <span>{result.status}</span>
          </div>
          {result.escrow && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: "#9ca3af" }}>escrow: </span>
              <a
                href={explorerUrl(result.escrow)}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#3b82f6" }}
              >
                {result.escrow.slice(0, 12)}…{result.escrow.slice(-6)}
              </a>
            </div>
          )}
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: "#9ca3af" }}>payer: </span>
            <span>
              {result.payer.slice(0, 12)}…{result.payer.slice(-6)}
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(result.payer)}
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid #27272a",
                background: "transparent",
                color: "#9ca3af",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              copy
            </button>
          </div>
          {result.claimSignature && (
            <div style={{ marginBottom: 6, color: "#22c55e" }}>
              ✓ claimed in tx {result.claimSignature.slice(0, 12)}…
            </div>
          )}
          {result.refundedEscrow && (
            <div style={{ marginBottom: 6, color: "#f59e0b" }}>
              ↩ auto-refunded — error: {result.error}
            </div>
          )}
          {result.output && (
            <details style={{ marginTop: 8, color: "#9ca3af" }}>
              <summary style={{ cursor: "pointer" }}>tool output</summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: "#000",
                  borderRadius: 6,
                  overflow: "auto",
                  fontSize: 12,
                  color: "#e7e7ea",
                }}
              >
                {JSON.stringify(result.output, null, 2)}
              </pre>
            </details>
          )}
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #27272a",
              color: "#9ca3af",
              fontSize: 12,
            }}
          >
            tip: paste the payer pubkey into &quot;as payer&quot; above and load
            escrows to see this one in the list.
          </div>
        </div>
      )}
    </section>
  );
}
