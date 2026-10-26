/**
 * Astral Atlas browser entry point.
 *
 * CSS order matters:
 * 1. App.jsx imports its landing and atlas styles.
 * 2. global.css preserves the existing local font imports and resets.
 * 3. palette-overrides.css applies the final green theme.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";

import "./styles/global.css";
import "./styles/palette-overrides.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error(
    "Astral Atlas could not find the #root element in index.html."
  );
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);