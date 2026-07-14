// Shared cancellation for one-at-a-time browser work (discovery pass, etc.).

let discoveryAbortRequested = false;

export function requestDiscoveryAbort(): void {
  discoveryAbortRequested = true;
}

export function resetDiscoveryAbort(): void {
  discoveryAbortRequested = false;
}

export function isDiscoveryAbortRequested(): boolean {
  return discoveryAbortRequested;
}

/** Stop runner + any in-flight discovery browse. */
export function requestAllBrowserTasksStop(): void {
  discoveryAbortRequested = true;
}
