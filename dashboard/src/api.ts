import { shellAuthToken } from "./shell";

export const API_AUTH_REQUIRED_EVENT = "applypilot:auth-required";
const API_TOKEN_KEY = "applypilot.apiToken";

export interface ApiDownload {
  name: string;
  url: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function getStoredApiToken(): string {
  // A manually-entered token (localStorage, e.g. the Tailscale/phone case) wins; otherwise fall back to
  // the token the desktop shell injected into the engine so the app auto-authenticates (commercial M7).
  try {
    const stored = localStorage.getItem(API_TOKEN_KEY);
    if (stored) return stored;
  } catch {
    /* storage unavailable — try the shell bridge */
  }
  return shellAuthToken();
}

export function setStoredApiToken(token: string): void {
  try {
    const clean = token.trim();
    if (clean) localStorage.setItem(API_TOKEN_KEY, clean);
    else localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function clearStoredApiToken(): void {
  try {
    localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function notifyAuthRequired(status: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { status } }));
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getStoredApiToken();
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    void reportNetworkError(input, error);
    throw error;
  }
  if (isAuthStatus(response.status)) notifyAuthRequired(response.status);
  return response;
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function reportNetworkError(input: RequestInfo | URL, error: unknown): Promise<void> {
  const path = requestPath(input);
  if (path.includes("/api/errors")) return;
  const token = getStoredApiToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const e = error instanceof Error ? error : new Error(String(error));
  try {
    await fetch("/api/errors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "frontend",
        severity: "error",
        name: e.name,
        message: e.message,
        stack: e.stack,
        context: { kind: "apiFetch.network", request: path },
      }),
    });
  } catch {
    /* API is likely unavailable; nothing else to do. */
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isApiRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.pathname
      : input.url;
  try {
    return new URL(url, window.location.origin).pathname.startsWith("/api/");
  } catch {
    return url.startsWith("/api/");
  }
}

export async function apiJson<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(input, {
    ...init,
    headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  });
  const body = await responseBody(response);
  if (response.ok && isApiRequest(input) && typeof body === "string") {
    throw new ApiRequestError(response.status, "API did not return JSON", body);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `API ${response.status}`;
    throw new ApiRequestError(response.status, message, body);
  }
  return body as T;
}

export function apiPostJson<T>(url: string, body: unknown): Promise<T> {
  return apiJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function downloadApiFile(file: ApiDownload): Promise<void> {
  const response = await apiFetch(file.url);
  if (!response.ok) {
    const body = await responseBody(response);
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Download failed: API ${response.status}`;
    throw new ApiRequestError(response.status, message, body);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
