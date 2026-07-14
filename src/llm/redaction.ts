// src/llm/redaction.ts
//
// The redaction invariant, client side (commercial M6). Only the job-fit reasoner payload — PII-free
// by construction (built from CandidateProfile + JobAnalysis; no contact/selfId/screening fields) —
// may leave the device for the paid cloud proxy. Résumé parsing and document generation stay on the
// local model. This module is the last-line TRIPWIRE the proxy provider runs on every outbound
// prompt: if any obvious PII marker is present, the call THROWS instead of transmitting. It backstops
// the structural guarantee (feature-aware routing sends only job-rerank to the proxy) so that even a
// future bug that routed a PII-bearing prompt to the proxy fails CLOSED — locally, before the network.
//
// Patterns are simple and LINEAR-TIME (no nested quantifiers) so a large prompt can't wedge the loop.
// We surface only the marker CATEGORY, never the matched text, so error logs never themselves leak PII.

export type PiiMarker = "email" | "phone" | "ssn" | "street_address" | "self_id";

const DETECTORS: { marker: PiiMarker; test: RegExp }[] = [
  { marker: "email", test: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/ },
  { marker: "phone", test: /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/ },
  { marker: "ssn", test: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/ },
  {
    marker: "street_address",
    test: /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter)\b/i,
  },
  {
    marker: "self_id",
    test: /\b(?:social security(?: number)?|ssn|date of birth|d\.?o\.?b\.?|disability status|veteran status|race\/ethnicity|gender identity|work authorization|require sponsorship)\b/i,
  },
];

export interface PiiScan {
  hasPii: boolean;
  markers: PiiMarker[];
}

/** Scan text for PII markers. Returns the categories that matched (never the matched substrings). */
export function scanForPii(text: string): PiiScan {
  const markers: PiiMarker[] = [];
  for (const d of DETECTORS) if (d.test.test(text)) markers.push(d.marker);
  return { hasPii: markers.length > 0, markers };
}

export class ProxyRedactionError extends Error {
  constructor(readonly markers: PiiMarker[]) {
    super(
      `Refusing to send this request to the cloud AI: it contains personal information (${markers.join(
        ", "
      )}). Only PII-free job-fit reasoning may use the cloud tier.`
    );
    this.name = "ProxyRedactionError";
  }
}

/**
 * Throw if `text` trips a PII marker. Called by the proxy provider on the combined system+user
 * prompt before any bytes leave the device. Fails closed — a caught error degrades to the local
 * deterministic path, never a silent cloud transmission of PII.
 */
export function assertProxySafe(text: string): void {
  const scan = scanForPii(text);
  if (scan.hasPii) throw new ProxyRedactionError(scan.markers);
}
