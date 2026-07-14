// src/cli/download-models.ts
//
// `npm run models:download` — fetch the bundled free-tier models (chat + embeddings) into the
// local models directory with resume + retry. Replaces the old Ollama-based pull-models script:
// no Ollama install is required anymore.

import { BUNDLED_MODELS, downloadModel, modelPath, modelsDir, modelStatuses } from "../llm/model-store";
import { existsSync } from "node:fs";

const out = (s: string) => process.stdout.write(s + "\n");

out(`ApplyPilot bundled models -> ${modelsDir()}`);
let failed = false;
for (const model of BUNDLED_MODELS) {
  if (existsSync(modelPath(model))) {
    out(`✓ ${model.id} (${model.kind}) already present`);
    continue;
  }
  out(`↓ ${model.id} (${model.kind}, ~${Math.round(model.approxBytes / 1e6)} MB, ${model.license})`);
  let lastShown = -1;
  try {
    await downloadModel(model, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct >= lastShown + 5) {
        lastShown = pct;
        process.stdout.write(`\r  ${pct}%   `);
      }
    });
    process.stdout.write("\r");
    out(`✓ ${model.id} downloaded`);
  } catch (err) {
    process.stdout.write("\r");
    out(`✗ ${model.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
}
out("");
for (const s of modelStatuses()) out(`${s.present ? "✓" : "✗"} ${s.id}: ${s.present ? "ready" : "missing"}`);
if (failed) process.exit(1);
