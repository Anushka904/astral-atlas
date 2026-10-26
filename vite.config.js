/**
 * Vite configuration for Astral Atlas.
 *
 * Browser compatibility:
 * Babel-related dependencies may contain compile-time process.env checks.
 * The values below are substituted during the build; they are not a Node.js
 * runtime or a place to store credentials.
 *
 * Performance:
 * The landing page loads the Atlas and editor through dynamic imports.
 * Vendor chunks keep graph and editor dependencies out of the initial view.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const nodeEnvironment =
    mode === "production" ? "production" : "development";

  return {
    plugins: [react()],

    define: {
      "process.env": JSON.stringify({
        NODE_ENV: nodeEnvironment,
        BABEL_8_BREAKING: false,
        BABEL_TYPES_8_BREAKING: false
      })
    },

    optimizeDeps: {
      include: [
        "@babel/parser",
        "@babel/traverse",
        "@babel/types"
      ]
    },

    worker: {
      format: "es"
    },

    build: {
      target: "es2022",
      sourcemap: false,

      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, "/");

            if (!normalized.includes("/node_modules/")) {
              return undefined;
            }

            if (
              normalized.includes("/node_modules/cytoscape/") ||
              normalized.includes("/node_modules/cytoscape-fcose/") ||
              normalized.includes("/node_modules/cytoscape-dagre/")
            ) {
              return "graph-vendor";
            }

            if (
              normalized.includes("/node_modules/@codemirror/") ||
              normalized.includes("/node_modules/@lezer/")
            ) {
              return "editor-vendor";
            }

            if (normalized.includes("/node_modules/@babel/")) {
              return "babel-vendor";
            }

            if (
              normalized.includes("/node_modules/react/") ||
              normalized.includes("/node_modules/react-dom/") ||
              normalized.includes("/node_modules/scheduler/")
            ) {
              return "react-vendor";
            }

            return undefined;
          }
        }
      }
    },

    // Keep the default chunk-size warning. It is useful for a performance-
    // focused hackathon project and should not be hidden merely to silence it.
  };
});