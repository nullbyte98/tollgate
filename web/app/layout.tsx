export const metadata = {
  title: "Tollgate — Refundable x402 Escrow",
  description: "Pay-on-success agent calls on Solana",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0b0d",
          color: "#e7e7ea",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
