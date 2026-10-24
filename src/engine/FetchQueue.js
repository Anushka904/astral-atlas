/**
 * Bounded asynchronous task queue.
 *
 * WHY:
 * - Bounded concurrency protects the browser and remote service.
 * - Retries recover from temporary throttling and server failures.
 * - Per-item failures are recorded so one broken file doesn't stop the run.
 * - AbortSignal lets the caller cancel the entire operation.
 */

function makeAbortError() {
  const error = new Error("The operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : makeAbortError();
  }
}

/**
 * Wait for a delay that can be interrupted by an AbortSignal.
 *
 * @param {number} milliseconds
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : makeAbortError()
      );
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);

    signal?.addEventListener("abort", onAbort, {
      once: true
    });
  });
}

function getItemLabel(item) {
  if (typeof item === "string") {
    return item;
  }

  return item?.path ?? item?.name ?? "task";
}

function isRetryable(error) {
  const status = Number(error?.status);

  return (
    status === 429 ||
    (status >= 500 && status <= 599) ||
    error?.retryable === true
  );
}

export default class FetchQueue {
  /**
   * @param {{
   *   concurrency?:number,
   *   maxRetries?:number,
   *   baseDelayMs?:number,
   *   maxDelayMs?:number,
   *   random?:()=>number
   * }} [options]
   */
  constructor({
    concurrency = 6,
    maxRetries = 3,
    baseDelayMs = 250,
    maxDelayMs = 4000,
    random = Math.random
  } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        "FetchQueue concurrency must be a positive integer."
      );
    }

    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(
        "FetchQueue maxRetries must be a non-negative integer."
      );
    }

    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.random = random;
  }

  /**
   * Run tasks with limited concurrency.
   *
   * Each settled result preserves the original item and its index.
   * Ordinary item failures are returned instead of throwing.
   * Cancellation rejects the overall operation.
   *
   * @template T,R
   * @param {T[]} items
   * @param {(item:T, context:{
   *   signal?:AbortSignal,
   *   attempt:number,
   *   index:number
   * })=>Promise<R>} task
   * @param {{
   *   signal?:AbortSignal,
   *   onProgress?:(event:object)=>void
   * }} [options]
   * @returns {Promise<Array<object>>}
   */
  async run(
    items,
    task,
    {
      signal,
      onProgress
    } = {}
  ) {
    if (!Array.isArray(items)) {
      throw new TypeError("FetchQueue items must be an array.");
    }

    if (typeof task !== "function") {
      throw new TypeError(
        "FetchQueue requires a task function."
      );
    }

    throwIfAborted(signal);

    if (items.length === 0) {
      return [];
    }

    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;

    const emitProgress = (event) => {
      if (typeof onProgress !== "function") {
        return;
      }

      try {
        onProgress(event);
      } catch (error) {
        // UI progress callbacks must not break download execution.
        console.error("FetchQueue progress callback failed.", error);
      }
    };

    const processItem = async (item, index) => {
      let attempt = 0;

      while (true) {
        throwIfAborted(signal);

        try {
          const value = await task(item, {
            signal,
            attempt,
            index
          });

          results[index] = {
            item,
            index,
            status: "fulfilled",
            value,
            attempts: attempt + 1
          };

          break;
        } catch (error) {
          if (
            error?.name === "AbortError" ||
            signal?.aborted
          ) {
            throw signal?.reason instanceof Error
              ? signal.reason
              : error?.name === "AbortError"
                ? error
                : makeAbortError();
          }

          if (
            !isRetryable(error) ||
            attempt >= this.maxRetries
          ) {
            results[index] = {
              item,
              index,
              status: "rejected",
              reason: error,
              attempts: attempt + 1
            };

            break;
          }

          // Exponential backoff plus random jitter spreads out retries
          // from users who experienced the same throttling response.
          const exponential =
            this.baseDelayMs * 2 ** attempt;

          const jitter = Math.floor(
            this.random() * this.baseDelayMs
          );

          const delay = Math.min(
            this.maxDelayMs,
            exponential + jitter
          );

          emitProgress({
            phase: "retry",
            done: completed,
            total: items.length,
            currentFile: getItemLabel(item),
            attempt: attempt + 1,
            retryInMs: delay
          });

          attempt += 1;
          await abortableDelay(delay, signal);
        }
      }

      completed += 1;

      emitProgress({
        phase: "download",
        done: completed,
        total: items.length,
        currentFile: getItemLabel(item),
        status: results[index].status
      });
    };

    const worker = async () => {
      while (true) {
        throwIfAborted(signal);

        // JavaScript runs this increment synchronously, so two workers
        // cannot claim the same index.
        const index = nextIndex++;

        if (index >= items.length) {
          return;
        }

        await processItem(items[index], index);
      }
    };

    const workerCount = Math.min(
      this.concurrency,
      items.length
    );

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    throwIfAborted(signal);

    return results;
  }
}