// src/ingestion/ledger-review.ts
//
// Interactive review/correction/approval of the parsed ledger. Parsing errors are common, so
// NOTHING is usable until the user approves it here. The user can approve, delete wrong facts,
// and add facts the parser missed. (Correcting a fact = delete + add.)

import type { Fact, FactsLedger, FactType } from "../types/facts-ledger";
import {
  addFact,
  describeFact,
  finalizeApproval,
  removeFact,
  setApproved,
  summarizeLedger,
  type FactDraft,
} from "./ledger-ops";
import type { Prompter } from "../cli/prompt";

export async function reviewLedgerInteractive(
  p: Prompter,
  input: FactsLedger
): Promise<FactsLedger> {
  let ledger = input;
  p.print("\n=== Review facts ledger ===");
  p.print("Only facts you APPROVE here can be used in generated documents. Nothing is");
  p.print("fabricated: generation may reorder/rephrase approved facts but never exceed them.\n");

  const summary = summarizeLedger(ledger);
  p.print(`Parsed ${summary.total} candidate fact(s).`);

  const approveAllFirst = await p.confirm(
    "Approve ALL parsed facts now, then fix individually?",
    false
  );
  if (approveAllFirst) {
    ledger = { ...ledger, facts: ledger.facts.map((f) => ({ ...f, approved: true })) };
  }

  // Fact-by-fact pass.
  for (const fact of [...ledger.facts]) {
    const current = ledger.facts.find((f) => f.id === fact.id);
    if (!current) continue;
    p.print(`\n${describeFact(current)}  ${current.approved ? "(approved)" : "(unapproved)"}`);
    if (current.sourceText) p.print(`  source: "${truncate(current.sourceText, 120)}"`);
    const action = await p.choice(
      "  Action",
      [
        { label: current.approved ? "Keep approved" : "Approve", value: "approve" },
        { label: "Leave unapproved (skip)", value: "skip" },
        { label: "Delete (wrong / not mine)", value: "delete" },
      ]
    );
    if (action === "approve") ledger = setApproved(ledger, current.id, true);
    else if (action === "skip") ledger = setApproved(ledger, current.id, false);
    else if (action === "delete") ledger = removeFact(ledger, current.id);
  }

  // Add facts the parser missed.
  while (await p.confirm("\nAdd a fact the parser missed?", false)) {
    ledger = await addFactInteractive(p, ledger);
  }

  ledger = finalizeApproval(ledger);
  const final = summarizeLedger(ledger);
  p.print(`\nLedger ready: ${final.approved}/${final.total} fact(s) approved.`);
  return ledger;
}

async function addFactInteractive(p: Prompter, ledger: FactsLedger): Promise<FactsLedger> {
  const type = (await p.choice("  Fact type", [
    { label: "Employment", value: "employment" },
    { label: "Education", value: "education" },
    { label: "Certification", value: "certification" },
    { label: "Skill", value: "skill" },
    { label: "Achievement", value: "achievement" },
    { label: "Metric", value: "metric" },
    { label: "Language", value: "language" },
    { label: "Summary point", value: "summary_point" },
  ])) as FactType | null;
  if (!type) return ledger;

  let fact: FactDraft;
  if (type === "employment") {
    const employer = await p.text("    Employer", { required: true });
    const title = await p.text("    Title", { required: true });
    const startDate = await p.text("    Start date (YYYY or YYYY-MM)", { required: true });
    const endDate = await p.text('    End date (YYYY, YYYY-MM, or "present")', { default: "present" });
    fact = { type, approved: true, employer, title, startDate, endDate, bullets: [] };
  } else if (type === "education") {
    const institution = await p.text("    Institution", { required: true });
    const degree = await p.text("    Degree", { required: true });
    const graduationDate = await p.text("    Graduation date (optional)");
    fact = {
      type,
      approved: true,
      institution,
      degree,
      ...(graduationDate ? { graduationDate } : {}),
    };
  } else if (type === "certification") {
    const name = await p.text("    Certification name", { required: true });
    const inProgress = await p.confirm("    In progress (not yet earned)?", false);
    fact = { type, approved: true, name, ...(inProgress ? { inProgress: true } : {}) };
  } else if (type === "metric") {
    const statement = await p.text("    Metric statement", { required: true });
    fact = { type, approved: true, statement };
  } else {
    const statement = await p.text("    Statement", { required: true });
    fact = { type, approved: true, statement };
  }
  return addFact(ledger, fact);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
