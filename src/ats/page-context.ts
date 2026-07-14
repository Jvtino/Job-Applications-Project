// src/ats/page-context.ts
//
// Concrete PageContext backed by a live Playwright Page. The brief keeps the PageContext
// interface thin (just `url`) so adapters stay testable; this binds it to a real page and
// gives adapters a typed accessor.

import type { Page } from "playwright";
import type { PageContext } from "./adapter";

export interface PlaywrightPageContext extends PageContext {
  readonly page: Page;
}

export function makePageContext(page: Page): PlaywrightPageContext {
  return {
    get url(): string {
      return page.url();
    },
    page,
  };
}

/** Narrow a PageContext to its backing Playwright Page (adapters call this). */
export function pwPage(ctx: PageContext): Page {
  const c = ctx as Partial<PlaywrightPageContext>;
  if (!c.page) {
    throw new Error("PageContext is not backed by a Playwright page.");
  }
  return c.page;
}
