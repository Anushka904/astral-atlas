/**
 * Vite configuration for Astral Atlas.
 *
 * WHY:
 * Some Babel-related dependencies contain compile-time checks that read
 * process.env.*. The browser does not provide Node's process global.
 *
 * We replace the supported environment-variable object at build time;
 * this does not install a Node.js runtime or expose a GitHub token.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const nodeEnvironment =
    mode === "production" ? "production" : "development";

  return {
    plugins: [react()],

    /**
     * Replace Node-style environment reads in browser-targeted dependencies.
     * Only the variables needed for environment branching are provided.
     */
    define: {
      "process.env": JSON.stringify({
        NODE_ENV: nodeEnvironment,
        BABEL_8_BREAKING: false,
        BABEL_TYPES_8_BREAKING: false
      })
    },

    /**
     * Pre-bundle Babel modules so the parser imports have consistent
     * browser-compatible module shapes during Vite development.
     */
    optimizeDeps: {
      include: [
        "@babel/parser",
        "@babel/traverse",
        "@babel/types"
      ]
    },

    /**
     * The parser is loaded using a module Web Worker. Keep ESM output.
     */
    worker: {
      format: "es"
    },

    build: {
      target: "es2022",
      sourcemap: false
    }
  };
});