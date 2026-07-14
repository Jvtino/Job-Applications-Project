// Vitest setup for the dashboard suite (commercial M10): Testing Library's jest-dom matchers
// (toBeInTheDocument, toBeDisabled, …) and automatic cleanup between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
