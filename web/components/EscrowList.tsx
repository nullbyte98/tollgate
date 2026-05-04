"use client";

import { useEffect, useState } from "react";

interface EscrowDto {
  address: string;
  payer: string;
  server: string;
  mint: string;
  amount: string;
  deadline: number;
  openedAt: number;
  settledAt: number;
  status: "open" | "claimed" | "refunded";
  receiptHex: string;
}

const STATUS_COLOR: Record<EscrowDto["status"], string> = {
  open: "#3b82f6",
  claimed: "#22c55e",
  refunded: "#f59e0b",
};

const truncate = (s: string, n = 8) => `${s.slice(0, n)}…${s.slice(-4)}`;
const fmtTs = (ts: number) =>
  ts === 0 ? "—" : new Date(ts * 1000).toLocaleString();
const fmtAmount = (raw: string) => `${(Number(raw) / 1_000_000).toFixed(6)} USDC`;

export default function EscrowList({
  pubkey,
  role,
}: {
  pubkey: string;
  role: "payer" | "server";
}) {
  const [escrows, setEscrows] = useState<EscrowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/escrows?pubkey=${encodeURIComponent(pubkey)}&role=${role}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setEscrows(data.escrows);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [pubkey, role]);

  if (loading) return <p style={{ color: "#9ca3af" }}>loading…</p>;
  if (error) return <p style={{ color: "#ef4444" }}>{error}</p>;
  if (!escrows) return null;
  if (escrows.length === 0)
    return <p style={{ color: "#9ca3af" }}>no escrows for this {role}.</p>;

  const totals = escrows.reduce(
    (acc, e) => {
      acc[e.status] += 1;
      return acc;
    },
    { open: 0, claimed: 0, refunded: 0 } as Record<EscrowDto["status"], number>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 14 }}>
        {(Object.keys(totals) as EscrowDto["status"][]).map((s) => (
          <span key={s} style={{ color: STATUS_COLOR[s] }}>
            {s}: <strong>{totals[s]}</strong>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {escrows
          .sort((a, b) => b.openedAt - a.openedAt)
          .map((e) => (
            <div
              key={e.address}
              style={{
                padding: 16,
                border: "1px solid #27272a",
                borderRadius: 12,
                background: "#111114",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: 8,
                }}
              >
                <code style={{ color: "#9ca3af", fontSize: 12 }}>
                  {truncate(e.address, 12)}
                </code>
                <span
                  style={{
                    padding: "3px 10px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    background: STATUS_COLOR[e.status],
                    color: "white",
                    textTransform: "uppercase",
                  }}
                >
                  {e.status}
                </span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                {fmtAmount(e.amount)}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr",
                  rowGap: 4,
                  fontSize: 13,
                  color: "#9ca3af",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                }}
              >
                <span>payer</span>
                <span>{truncate(e.payer)}</span>
                <span>server</span>
                <span>{truncate(e.server)}</span>
                <span>mint</span>
                <span>{truncate(e.mint)}</span>
                <span>opened</span>
                <span>{fmtTs(e.openedAt)}</span>
                <span>deadline</span>
                <span>{fmtTs(e.deadline)}</span>
                <span>settled</span>
                <span>{fmtTs(e.settledAt)}</span>
                {e.status === "claimed" && e.receiptHex.replace(/0/g, "") !== "" && (
                  <>
                    <span>receipt</span>
                    <span style={{ wordBreak: "break-all" }}>
                      {e.receiptHex.slice(0, 32)}…
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}
