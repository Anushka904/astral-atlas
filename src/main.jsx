/**
 * Astral Atlas browser entry point.
 *
 * CSS load order:
 * 1. App.jsx loads component and layout styles.
 * 2. global.css provides resets and locally hosted fonts.
 * 3. palette-overrides.css retains the existing application styling.
 * 4. tech-theme.css provides the final graphite/violet visual theme.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";

import "./styles/global.css";
import "./styles/palette-overrides.css";
import "./styles/tech-theme.css";

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