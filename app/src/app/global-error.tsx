"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 32 }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: "#888", fontSize: 14, marginBottom: 16 }}>
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={reset}
            style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 6, padding: "8px 24px", fontSize: 14, cursor: "pointer" }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
