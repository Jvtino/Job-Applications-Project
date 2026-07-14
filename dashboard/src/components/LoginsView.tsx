// The "Logins" tab. Lets the user save career-site logins (email + password) that ApplyPilot can
// auto-enter, backed by the local, survives-app-deletion credential vault (/api/logins). Reads are
// metadata-only — a saved password is never sent back to the browser; we only ever POST a new one.

import { useEffect, useState, type FormEvent } from "react";
import { apiJson, apiPostJson } from "../api";

interface CredentialMeta {
  domain: string;
  email: string;
  hasPassword: boolean;
  origin: "user" | "generated";
  updatedAt: string;
}
interface VaultLocation {
  dir: string;
  path: string;
  keyPath: string;
  note: string;
}
interface LoginsResponse {
  location: VaultLocation;
  logins: CredentialMeta[];
}

export function LoginsView({ onToast }: { onToast: (message: string) => void }) {
  const [data, setData] = useState<LoginsResponse | null>(null);
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    apiJson<LoginsResponse>("/api/logins")
      .then(setData)
      .catch((e) => onToast(`Couldn't load logins: ${String((e as Error).message ?? e)}`));

  useEffect(() => {
    void load();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!domain.trim() || !email.trim()) {
      onToast("Site and email are required.");
      return;
    }
    setBusy(true);
    try {
      await apiPostJson("/api/logins", {
        domain: domain.trim(),
        email: email.trim(),
        ...(password ? { password } : {}),
      });
      setDomain("");
      setEmail("");
      setPassword("");
      onToast("Login saved on this device.");
      await load();
    } catch (e) {
      onToast(`Couldn't save: ${String((e as Error).message ?? e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: string) {
    try {
      await apiPostJson("/api/logins/delete", { domain: d });
      onToast(`Removed ${d}`);
      await load();
    } catch (e) {
      onToast(`Couldn't remove: ${String((e as Error).message ?? e)}`);
    }
  }

  return (
    <div className="apx-view logins-view">
      <header className="apx-view-head">
        <p className="eyebrow">Saved on this device</p>
        <h1>Logins</h1>
        <p>
          Save your career-site logins so ApplyPilot can sign you in and, for a new site, create an
          account for you. Passwords are encrypted on this Mac.
        </p>
      </header>

      {data ? (
        <div className="apx-card apx-note">
          <strong>Where your logins are saved</strong>
          <p>{data.location.note}</p>
          <p>
            Location: <code>{data.location.path}</code>
          </p>
        </div>
      ) : null}

      <section className="apx-card">
        <h2>Add a login</h2>
        <form onSubmit={save} className="apx-form logins-form">
          <label>
            Site (domain)
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="td.wd3.myworkdayjobs.com" />
          </label>
          <label>
            Email / username
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="stored encrypted on this device" autoComplete="off" />
          </label>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save login"}
          </button>
        </form>
      </section>

      <section className="apx-card">
        <h2>Saved logins {data ? `(${data.logins.length})` : ""}</h2>
        {!data ? (
          <p>Loading…</p>
        ) : data.logins.length === 0 ? (
          <p>No logins saved yet. Add one above, or ApplyPilot will save one when it creates an account for you.</p>
        ) : (
          <ul className="apx-list logins-list">
            {data.logins.map((l) => (
              <li key={l.domain} className="apx-row logins-row">
                <div>
                  <strong>{l.domain}</strong>
                  <br />
                  <small>
                    {l.email} · {l.hasPassword ? "password saved" : "no password"}
                    {l.origin === "generated" ? " · created by ApplyPilot" : ""}
                  </small>
                </div>
                <button className="button secondary" type="button" onClick={() => void remove(l.domain)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
