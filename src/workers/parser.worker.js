/**
 * Astral Atlas AST parser worker.
 *
 * WHY: Parsing and AST traversal can be CPU-intensive. Running them in
 * a Web Worker prevents the browser's main UI thread from doing this work.
 *
 * Only a compact summary is posted back. The AST never leaves this worker.
 */

import { parseSource } from "../engine/parser/parseSource.js";

self.addEventListener("message", (event) => {
  const message = event.data;

  if (!message || message.type !== "parse") {
    return;
  }

  const {
    id,
    content,
    path,
    sha
  } = message;

  try {
    const result = parseSource(content, {
      path,
      sha
    });

    self.postMessage({
      id,
      ok: true,
      result
    });
  } catch (error) {
    // Unexpected worker-level failures are reported to the caller.
    // The pool can then mark only this file as failed and continue.
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ??
          "An unexpected parser worker error occurred."
      }
    });
  }
});