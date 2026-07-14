// In-app Help & Diagnostics (commercial M9-D). Customer-plain help + privacy summary + a self-service
// diagnostics view over the engine's already-PII-scrubbed error reports (M7). Nothing is uploaded: the
// "Save diagnostics file" action downloads the scrubbed reports locally so the user can choose to share
// them with support. No terminal, no developer voice.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { apiJson } from "../api";

interface DiagnosticReport {
  id: string;
  createdAt: string;
  source: string;
  severity?: string;
  message: string;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function HelpDiagnosticsView({ onToast }: { onToast: (message: string) => void }) {
  const [reports, setReports] = useState<DiagnosticReport[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await apiJson<{ reports?: DiagnosticReport[] }>("/api/errors?limit=20");
        if (active) setReports(data.reports ?? []);
      } catch {
        if (active) setReports([]); // engine down / no reports — the page still renders help content
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const saveDiagnostics = async () => {
    try {
      const data = await apiJson<{ reports?: DiagnosticReport[] }>("/api/errors?limit=200");
      const blob = new Blob([JSON.stringify(data.reports ?? [], null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "applypilot-diagnostics.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onToast("Saved a diagnostics file. It was scrubbed of personal details — review it before sharing with support.");
    } catch (e) {
      onToast(`Couldn't prepare diagnostics: ${String((e as Error).message ?? e)}`);
    }
  };

  return (
    <div className="settings-view help-view">
      <section className="settings-subpanel">
        <h2>Getting started</h2>
        <p className="settings-hint">
          ApplyPilot finds US jobs that fit your résumé and helps you apply. Everything runs on this Mac: add
          your résumé, review the facts it pulled out, then run a search to see matched roles. When you apply,
          ApplyPilot fills the employer&rsquo;s form for you to check — you always press submit yourself.
        </p>
      </section>

      <section className="settings-subpanel">
        <h2>Your privacy</h2>
        <p className="settings-hint">
          Your résumé, answers, and personal information stay on this Mac. On the free plan, nothing is sent
          to any ApplyPilot server. On the paid plan, only a de-identified job-fit summary — no contact
          details, no self-identification answers, no résumé text — is used to rank jobs.
        </p>
      </section>

      <section className="settings-subpanel">
        <h2>Something not working?</h2>
        <p className="settings-hint">
          If a page says ApplyPilot isn&rsquo;t running, use the Restart button it shows. If something still
          looks stuck, quit and reopen ApplyPilot — that clears most issues.
        </p>
      </section>

      <section className="settings-subpanel">
        <h2>Diagnostics</h2>
        <p className="settings-hint">
          Recent problem reports are saved on this Mac and scrubbed of personal details. Nothing is sent
          anywhere automatically — you can save them to a file to share with support if you ask for help.
        </p>
        {reports === null ? (
          <p className="settings-hint">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="settings-hint">No recent problems recorded.</p>
        ) : (
          <ul className="help-diagnostics-list">
            {reports.map((r) => (
              <li key={r.id}>
                <span className="help-diag-when">{formatWhen(r.createdAt)}</span>
                <span className="help-diag-msg">{r.message}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-actions">
          <button className="button secondary" type="button" onClick={() => void saveDiagnostics()}>
            Save diagnostics file
          </button>
        </div>
      </section>

      <section className="settings-subpanel">
        <h2>Contact support</h2>
        <p className="settings-hint">
          Need a hand? Email <a href="mailto:support@applypilot.app">support@applypilot.app</a> and attach
          your diagnostics file if you saved one.
        </p>
      </section>

      <p className="safety-note">
        <Icon name="shield" />
        Everything here stays on your Mac unless you choose to share it.
      </p>
    </div>
  );
}
