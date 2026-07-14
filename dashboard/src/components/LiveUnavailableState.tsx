// The engine-down banner (commercial M9 self-healing). Plain customer copy plus a "Restart ApplyPilot"
// button when running inside the desktop shell — which can restart the engine in place — and a Retry
// fallback in plain-browser dev. Extracted from App.tsx so it can be unit-tested (commercial M10).
import { useState } from "react";
import { Icon } from "./Icon";
import { hasDesktopShell, restartEngine } from "../shell";

export function LiveUnavailableState({ onRetry }: { onRetry: () => void }) {
  const [restarting, setRestarting] = useState(false);
  const canRestart = hasDesktopShell();
  const restart = async () => {
    setRestarting(true);
    // On success the shell reloads the window; if it didn't (plain browser / failed), fall back to a refetch.
    const ok = await restartEngine();
    if (!ok) {
      setRestarting(false);
      onRetry();
    }
  };
  return (
    <div className="state-card panel live-unavailable">
      <Icon name="spark" />
      <h2>ApplyPilot isn't running</h2>
      <p>{canRestart ? "Restart ApplyPilot to load your jobs." : "Open the ApplyPilot app to load your jobs."}</p>
      <div className="live-unavailable-actions">
        {canRestart ? (
          <button className="button" type="button" onClick={() => void restart()} disabled={restarting}>
            {restarting ? "Restarting…" : "Restart ApplyPilot"}
          </button>
        ) : null}
        <button className="button compact" type="button" onClick={onRetry} disabled={restarting}>
          Retry
        </button>
      </div>
    </div>
  );
}
