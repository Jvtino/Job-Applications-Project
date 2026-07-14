// In-app Help & Diagnostics view (commercial M9-D). Renders customer help content and lists the engine's
// (already PII-scrubbed) recent error reports; nothing is uploaded.
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HelpDiagnosticsView } from "./HelpDiagnosticsView";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockErrorsEndpoint(reports: unknown[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, reports }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

describe("HelpDiagnosticsView", () => {
  it("shows customer help + privacy content and a diagnostics action", async () => {
    mockErrorsEndpoint([]);
    render(<HelpDiagnosticsView onToast={() => {}} />);

    expect(screen.getByRole("heading", { name: /Getting started/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Your privacy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save diagnostics file/i })).toBeInTheDocument();
    // No developer-voice: the copy never mentions a terminal command or an env var.
    expect(screen.queryByText(/npm run|\.env|localhost/i)).toBeNull();

    await waitFor(() => expect(screen.getByText(/No recent problems recorded/i)).toBeInTheDocument());
  });

  it("lists recent scrubbed diagnostic reports when the engine has any", async () => {
    mockErrorsEndpoint([
      { id: "e1", createdAt: "2026-07-04T10:00:00.000Z", source: "api", message: "A search step failed" },
    ]);
    render(<HelpDiagnosticsView onToast={() => {}} />);
    await waitFor(() => expect(screen.getByText(/A search step failed/i)).toBeInTheDocument());
  });
});
