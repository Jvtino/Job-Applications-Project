// Dashboard API client — token storage precedence + the auth/network behaviour of apiFetch
// (commercial M10 dashboard test infrastructure). These are the seams the whole UI depends on for
// talking to the local engine, so they get pinned first.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  API_AUTH_REQUIRED_EVENT,
  apiFetch,
  getStoredApiToken,
  setStoredApiToken,
  clearStoredApiToken,
  isAuthStatus,
} from "./api";

type MutableWindow = typeof window & { applyPilotShell?: unknown };

beforeEach(() => {
  localStorage.clear();
  (window as MutableWindow).applyPilotShell = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("token storage precedence", () => {
  it("prefers a manually-entered token, then the desktop shell's injected token", () => {
    expect(getStoredApiToken()).toBe("");
    (window as MutableWindow).applyPilotShell = { authToken: "shell-tok", reviewPanel: {} };
    expect(getStoredApiToken()).toBe("shell-tok"); // shell fallback when nothing stored
    setStoredApiToken("manual-tok");
    expect(getStoredApiToken()).toBe("manual-tok"); // a pasted token wins over the shell
    clearStoredApiToken();
    expect(getStoredApiToken()).toBe("shell-tok"); // clearing falls back to the shell again
  });
});

describe("isAuthStatus", () => {
  it("flags only 401/403", () => {
    expect(isAuthStatus(401)).toBe(true);
    expect(isAuthStatus(403)).toBe(true);
    expect(isAuthStatus(200)).toBe(false);
    expect(isAuthStatus(500)).toBe(false);
  });
});

describe("apiFetch", () => {
  it("attaches the stored bearer token", async () => {
    setStoredApiToken("secret-tok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/state");
    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer secret-tok");
  });

  it("sends no Authorization header when no token is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/health");
    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("dispatches the auth-required event on a 401 so the UI can prompt for a token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const handler = vi.fn();
    window.addEventListener(API_AUTH_REQUIRED_EVENT, handler);
    const res = await apiFetch("/api/state");
    expect(res.status).toBe(401);
    expect(handler).toHaveBeenCalledOnce();
    window.removeEventListener(API_AUTH_REQUIRED_EVENT, handler);
  });

  it("does not fire the auth event on a normal 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const handler = vi.fn();
    window.addEventListener(API_AUTH_REQUIRED_EVENT, handler);
    await apiFetch("/api/state");
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener(API_AUTH_REQUIRED_EVENT, handler);
  });
});
