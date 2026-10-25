/**
 * Wrapper for one AST parser Web Worker.
 *
 * WHY: Callers should not need to manage worker message IDs, events,
 * transfer errors, or termination logic themselves.
 */

let nextRequestId = 1;

/**
 * Build an AbortError consistently across browser environments.
 *
 * @param {AbortSignal|undefined} signal
 * @returns {Error}
 */
function abortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("Parsing was cancelled.");
  error.name = "AbortError";

  return error;
}

export default class ParserWorker {
  /**
   * @param {{
   *   workerFactory?:()=>Worker
   * }} [options]
   */
  constructor({ workerFactory } = {}) {
    this.workerFactory =
      workerFactory ??
      (() => new Worker(
        new URL("../workers/parser.worker.js", import.meta.url),
        { type: "module" }
      ));

    this.worker = null;
    this.pending = null;
    this.destroyed = false;

    this.handleMessage = this.handleMessage.bind(this);
    this.handleFailure = this.handleFailure.bind(this);

    this.createWorker();
  }

  /**
   * Create a fresh Worker instance.
   *
   * @returns {void}
   */
  createWorker() {
    if (this.destroyed) {
      throw new Error(
        "Cannot create a parser worker after destruction."
      );
    }

    const worker = this.workerFactory();

    worker.addEventListener(
      "message",
      this.handleMessage
    );

    worker.addEventListener(
      "error",
      this.handleFailure
    );

    worker.addEventListener(
      "messageerror",
      this.handleFailure
    );

    this.worker = worker;
  }

  /**
   * Detach and terminate the active Worker.
   *
   * @returns {void}
   */
  terminateWorker() {
    if (!this.worker) {
      return;
    }

    this.worker.removeEventListener(
      "message",
      this.handleMessage
    );

    this.worker.removeEventListener(
      "error",
      this.handleFailure
    );

    this.worker.removeEventListener(
      "messageerror",
      this.handleFailure
    );

    this.worker.terminate();
    this.worker = null;
  }

  /**
   * Clear the active request and remove its abort listener.
   *
   * @returns {object|null}
   */
  clearPending() {
    const pending = this.pending;

    if (pending?.signal && pending.onAbort) {
      pending.signal.removeEventListener(
        "abort",
        pending.onAbort
      );
    }

    this.pending = null;

    return pending;
  }

  /**
   * Handle a message from the worker.
   *
   * @param {MessageEvent} event
   */
  handleMessage(event) {
    const message = event.data;
    const pending = this.pending;

    // Ignore old responses, including those from a replaced worker.
    if (!pending || message?.id !== pending.id) {
      return;
    }

    this.clearPending();

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    const error = new Error(
      message.error?.message ??
        "The parser worker failed."
    );

    error.name = message.error?.name ?? "Error";

    pending.reject(error);
  }

  /**
   * Handle Worker crashes and structured-clone failures.
   *
   * The affected job rejects, and a replacement worker is created for
   * future jobs where possible.
   *
   * @param {ErrorEvent|MessageEvent} event
   */
  handleFailure(event) {
    event.preventDefault?.();

    const pending = this.clearPending();

    this.terminateWorker();

    if (pending) {
      const error = new Error(
        event.message ??
          "The parser worker stopped unexpectedly."
      );

      error.name = "ParserWorkerError";
      pending.reject(error);
    }

    if (!this.destroyed) {
      try {
        this.createWorker();
      } catch (error) {
        console.error(
          "Could not replace the parser worker.",
          error
        );
      }
    }
  }

  /**
   * Parse one source file.
   *
   * Only one request may be active per worker at a time.
   *
   * @param {{
   *   content:string,
   *   path:string,
   *   sha?:string|null
   * }} file
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  parse(file, { signal } = {}) {
    if (this.destroyed) {
      return Promise.reject(
        new Error("This parser worker has been destroyed.")
      );
    }

    if (this.pending) {
      return Promise.reject(
        new Error(
          "This parser worker already has an active request."
        )
      );
    }

    if (!file || typeof file.content !== "string") {
      return Promise.reject(
        new TypeError(
          "ParserWorker requires source text as a string."
        )
      );
    }

    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }

    if (!this.worker) {
      try {
        this.createWorker();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    const id = nextRequestId++;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.pending?.id !== id) {
          return;
        }

        const pending = this.clearPending();

        // JavaScript parsing is synchronous inside the worker. Terminating
        // this worker is the reliable way to stop an in-progress parse.
        this.terminateWorker();

        if (!this.destroyed) {
          try {
            this.createWorker();
          } catch (error) {
            console.error(
              "Could not restart the cancelled parser worker.",
              error
            );
          }
        }

        pending?.reject(abortError(signal));
      };

      this.pending = {
        id,
        resolve,
        reject,
        signal,
        onAbort
      };

      signal?.addEventListener("abort", onAbort, {
        once: true
      });

      try {
        this.worker.postMessage({
          id,
          type: "parse",
          content: file.content,
          path: file.path,
          sha: file.sha ?? null
        });
      } catch (error) {
        this.clearPending();
        reject(error);
      }
    });
  }

  /**
   * Terminate the worker and reject any pending request.
   *
   * @returns {void}
   */
  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    const pending = this.clearPending();

    this.terminateWorker();

    if (pending) {
      const error = new Error(
        "The parser worker was destroyed."
      );

      error.name = "AbortError";
      pending.reject(error);
    }
  }
}