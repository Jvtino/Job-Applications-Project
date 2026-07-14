// Live status for an in-flight Targets "Run discovery" pass (polled by the dashboard).

export interface DiscoveryTaskStatus {
  running: boolean;
  message: string;
  startedAt: string | null;
  /** Newest-first status lines for the in-app progress panel. */
  log: string[];
}

const LOG_MAX = 24;

let status: DiscoveryTaskStatus = {
  running: false,
  message: "",
  startedAt: null,
  log: [],
};

export function startDiscoveryTask(message = "Starting discovery…"): void {
  status = {
    running: true,
    message,
    startedAt: new Date().toISOString(),
    log: [message],
  };
}

export function setDiscoveryProgress(message: string): void {
  if (!message.trim()) return;
  status.message = message;
  status.log = [message, ...status.log.filter((l) => l !== message)].slice(0, LOG_MAX);
}

export function finishDiscoveryTask(message = "Discovery finished"): void {
  status = {
    ...status,
    running: false,
    message,
    log: [message, ...status.log.filter((l) => l !== message)].slice(0, LOG_MAX),
  };
}

export function getDiscoveryTaskStatus(): DiscoveryTaskStatus {
  return {
    running: status.running,
    message: status.message,
    startedAt: status.startedAt,
    log: [...status.log],
  };
}
