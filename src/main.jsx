
import React from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/landing.css";

import App from "./App.jsx";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error(
    'Astral Atlas could not start because the HTML element "#root" is missing.'
  );
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
