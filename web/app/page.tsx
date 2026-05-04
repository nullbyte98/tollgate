"use client";

import { useState } from "react";
import EscrowList from "../components/EscrowList";

export default function Home() {
  const [pubkey, setPubkey] = useState("");
  const [role, setRole] = useState<"payer" | "server">("payer");
  const [active, setActive] = useState<{ pubkey: string; role: "payer" | "server" } | null>(null);

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "48px 24px" }}>
      <header style={{ marginBottom: 40 }}>
        <h1 style={{ margin: 0, fontSize: 40, letterSpacing: -1 }}>
          tollgate
        </h1>
        <p style={{ margin: "8px 0 0", color: "#9ca3af", fontSize: 16 }}>
          server-attested x402 escrows on solana — claim with a receipt hash,
          refund on self-detected failure or deadline timeout
        </p>
      </header>

      <section
        style={{
          padding: 24,
          border: "1px solid #27272a",
          borderRadius: 12,
          background: "#111114",
        }}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {(["payer", "server"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #27272a",
                background: role === r ? "#3b82f6" : "transparent",
                color: role === r ? "white" : "#9ca3af",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              as {r}
            </button>
          ))}
        </div>

        <input
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="paste a solana pubkey"
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid #27272a",
            background: "#0b0b0d",
            color: "#e7e7ea",
            fontSize: 14,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            boxSizing: "border-box",
          }}
        />

        <button
          onClick={() => setActive({ pubkey, role })}
          disabled={!pubkey}
          style={{
            marginTop: 12,
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            background: pubkey ? "#3b82f6" : "#27272a",
            color: "white",
            cursor: pubkey ? "pointer" : "not-allowed",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          load escrows
        </button>
      </section>

      {active && (
        <section style={{ marginTop: 32 }}>
          <EscrowList pubkey={active.pubkey} role={active.role} />
        </section>
      )}
    </main>
  );
}
