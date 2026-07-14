// src/ats/generic-fallback.ts
//
// Last-resort adapter for any unrecognized application form. Uses the same generic labeled-field
// engine, but unknown forms are always routed through human review; the shared submit gate never
// auto-submits the "generic" adapter.

import { GreenhouseAdapter } from "./greenhouse";
import type { PageContext } from "./adapter";

export class GenericFallbackAdapter extends GreenhouseAdapter {
  readonly name = "generic";

  async detect(_ctx: PageContext): Promise<boolean> {
    return true; // only ever tried after the specific adapters decline
  }
}
