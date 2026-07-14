import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, installFrontendErrorReporting } from "./error-reporting";
import "./styles/shared.css";
import "./design-system/index.css";
import "./styles/chronicle.css";
import "./design-system/redesign.css";
import "./design-system/primitives.css";

installFrontendErrorReporting();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
