import React from "react";
import { getStoredApiToken } from "./api";

type Severity = "info" | "warning" | "error" | "fatal";

interface ClientErrorReport {
  severity?: Severity;
  message: string;
  name?: string;
  stack?: string;
  context?: Record<string, unknown>;
  tags?: string[];
}

function errorShape(error: unknown): Pick<ClientErrorReport, "message" | "name" | "stack"> {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error) };
}

export async function reportClientError(error: unknown, context: Record<string, unknown> = {}, severity: Severity = "error"): Promise<string | null> {
  const token = getStoredApiToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch("/api/errors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "frontend",
        severity,
        ...errorShape(error),
        context: {
          // Send only the route (pathname), not the full href (query/hash can carry data), and drop
          // navigator.userAgent — a device fingerprint of near-zero value on a single-user local app.
          // The server scrubber stays authoritative; this just minimizes what leaves the page (M7).
          url: window.location.pathname,
          ...context,
        },
      } satisfies ClientErrorReport & { source: "frontend" }),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok && body?.errorId ? String(body.errorId) : null;
  } catch {
    return null;
  }
}

export function installFrontendErrorReporting(): void {
  window.addEventListener("error", (event) => {
    void reportClientError(event.error ?? event.message, {
      kind: "window.error",
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    void reportClientError(event.reason, { kind: "unhandledrejection" });
  });
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { errorId: string | null; failed: boolean }> {
  state = { errorId: null, failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    void reportClientError(error, { kind: "react.error-boundary", componentStack: info.componentStack }, "fatal").then((errorId) => {
      if (errorId) this.setState({ errorId });
    });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f0ebe2", color: "#4c3421" }}>
        <section style={{ maxWidth: 520, padding: 24, border: "2px solid #4c3421", borderRadius: 8, background: "#f9f7f4" }}>
          <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>Dashboard error</p>
          <h1 style={{ margin: "0 0 10px", fontSize: 26 }}>ApplyPilot saved an error report.</h1>
          <p style={{ margin: 0, lineHeight: 1.5 }}>Please restart ApplyPilot — that usually fixes it. A private error report was saved on this Mac to help with support.</p>
          {this.state.errorId ? <p style={{ margin: "12px 0 0", fontFamily: "monospace", fontSize: 12 }}>Error ID: {this.state.errorId}</p> : null}
        </section>
      </main>
    );
  }
}
