// The engine-down banner + self-healing restart (commercial M9, tested under M10's RTL infra). This is
// the acceptance's "engine-down fallback": a customer sees a plain message and a one-click recovery, not
// a developer instruction.
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveUnavailableState } from "./LiveUnavailableState";

type MutableWindow = typeof window & { applyPilotShell?: unknown };

afterEach(() => {
  (window as MutableWindow).applyPilotShell = undefined;
});

describe("LiveUnavailableState", () => {
  it("plain-browser dev (no shell): shows plain copy, no Restart button, Retry refetches", async () => {
    const onRetry = vi.fn();
    render(<LiveUnavailableState onRetry={onRetry} />);

    expect(screen.getByRole("heading", { name: /ApplyPilot isn't running/i })).toBeInTheDocument();
    expect(screen.getByText(/Open the ApplyPilot app/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restart ApplyPilot/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("desktop shell: the Restart button drives the bridge and does NOT double-fall-back on success", async () => {
    const restart = vi.fn().mockResolvedValue(true);
    (window as MutableWindow).applyPilotShell = { restartEngine: restart, reviewPanel: {} };
    const onRetry = vi.fn();
    render(<LiveUnavailableState onRetry={onRetry} />);

    expect(screen.getByText(/Restart ApplyPilot to load your jobs/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Restart ApplyPilot/i }));

    await waitFor(() => expect(restart).toHaveBeenCalledOnce());
    // On success the shell reloads the window, so the button stays "Restarting…" and onRetry is NOT called.
    await waitFor(() => expect(screen.getByRole("button", { name: /Restarting/i })).toBeDisabled());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("desktop shell: a failed restart falls back to Retry so the user isn't stuck", async () => {
    const restart = vi.fn().mockResolvedValue(false);
    (window as MutableWindow).applyPilotShell = { restartEngine: restart, reviewPanel: {} };
    const onRetry = vi.fn();
    render(<LiveUnavailableState onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: /Restart ApplyPilot/i }));
    await waitFor(() => expect(restart).toHaveBeenCalledOnce());
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });
});
