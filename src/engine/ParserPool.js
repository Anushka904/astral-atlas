/**
 * Bounded pool for parsing files in Web Workers.
 *
 * WHY:
 * - Parsing must not run on the browser's main UI thread.
 * - A small pool avoids creating hundreds of worker threads.
 * - Results are returned in source-file input order.
 * - Each worker or source-file failure is isolated from other files.
 */

import ParserWorker from "./ParserWorker.js";
import FileInfo from "./FileInfo.js";
import CacheStore from "./CacheStore.js";

/**
 * Calculate the recommended parser pool size.
 *
 * @param {number|undefined} hardwareConcurrency
 * @returns {number}
 */
export function getRecommendedWorkerCount(
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency
) {
  const cores = Number.isInteger(hardwareConcurrency) &&
    hardwareConcurrency > 0
    ? hardwareConcurrency
    : 2;

  return Math.max(
    1,
    Math.min(4, cores - 1)
  );
}

/**
 * Notify progress listeners without letting their errors break parsing.
 *
 * @param {Function|undefined} callback
 * @param {object} event
 */
function notifyProgress(callback, event) {
  if (typeof callback !== "function") {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    console.error(
      "ParserPool progress callback failed.",
      error
    );
  }
}

/**
 * Throw a useful error if the current run has been cancelled.
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) {
      throw signal.reason;
    }

    const error = new Error("Parsing was cancelled.");
    error.name = "AbortError";

    throw error;
  }
}

export default class ParserPool {
  /**
   * @param {{
   *   size?:number,
   *   cacheStore?:CacheStore,
   *   workerFactory?:()=>Worker
   * }} [options]
   */
  constructor({
    size = getRecommendedWorkerCount(),
    cacheStore = new CacheStore(),
    workerFactory
  } = {}) {
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      size > 4
    ) {
      throw new RangeError(
        "ParserPool size must be an integer between 1 and 4."
      );
    }

    this.size = size;
    this.cacheStore = cacheStore;
    this.workerFactory = workerFactory;
    this.running = false;
    this.destroyed = false;

    this.workers = Array.from(
      { length: size },
      () => new ParserWorker({
        workerFactory: this.workerFactory
      })
    );
  }

  /**
   * Parse a collection of repository files.
   *
   * File records must have a path and either:
   * - source content, or
   * - a cachedSummary from CacheStore.
   *
   * The returned summaries never contain AST objects or source text.
   *
   * @param {Array<object>} files
   * @param {{
   *   signal?:AbortSignal,
   *   onProgress?:(event:object)=>void
   * }} [options]
   * @returns {Promise<{
   *   results:Array<object>,
   *   stats:{
   *     total:number,
   *     parsed:number,
   *     cacheHits:number,
   *     failed:number,
   *     cacheWriteFailures:number
   *   }
   * }>}
   */
  async parseFiles(files, {
    signal,
    onProgress
  } = {}) {
    if (this.destroyed) {
      throw new Error(
        "This parser pool has been destroyed."
      );
    }

    if (this.running) {
      throw new Error(
        "This parser pool already has a parsing run in progress."
      );
    }

    if (!Array.isArray(files)) {
      throw new TypeError(
        "ParserPool expects an array of file records."
      );
    }

    throwIfAborted(signal);

    if (files.length === 0) {
      return {
        results: [],
        stats: {
          total: 0,
          parsed: 0,
          cacheHits: 0,
          failed: 0,
          cacheWriteFailures: 0
        }
      };
    }

    this.running = true;

    const results = new Array(files.length);
    let nextIndex = 0;
    let completed = 0;

    const stats = {
      total: files.length,
      parsed: 0,
      cacheHits: 0,
      failed: 0,
      cacheWriteFailures: 0
    };

    const processOne = async (worker, file, index) => {
      let summary;
      let fromCache = false;
      let cacheWriteFailed = false;

      if (
        file.cachedSummary &&
        typeof file.cachedSummary === "object"
      ) {
        // The repository loader already checked parserVersion.
        // No worker or download is necessary for a valid cached summary.
        summary = file.cachedSummary;
        fromCache = true;
        stats.cacheHits += 1;
      } else if (file.loadError) {
        summary = FileInfo.failed(
          file.path,
          file.sha ?? null,
          file.loadError
        ).toJSON();

        stats.failed += 1;
      } else if (typeof file.content !== "string") {
        summary = FileInfo.failed(
          file.path,
          file.sha ?? null,
          "The source content is unavailable."
        ).toJSON();

        stats.failed += 1;
      } else {
        try {
          summary = await worker.parse(
            {
              path: file.path,
              sha: file.sha ?? null,
              content: file.content
            },
            { signal }
          );

          if (summary.parseStatus === "error") {
            stats.failed += 1;
          } else {
            stats.parsed += 1;
          }
        } catch (error) {
          if (
            error?.name === "AbortError" ||
            signal?.aborted
          ) {
            throw error;
          }

          // A worker crash affects this file only. ParserWorker attempts
          // to replace the failed worker for subsequent jobs.
          summary = FileInfo.failed(
            file.path,
            file.sha ?? null,
            error?.message ??
              "The parser worker failed unexpectedly."
          ).toJSON();

          stats.failed += 1;
        }
      }

      if (
        !fromCache &&
        summary.parseStatus !== "error" &&
        typeof file.sha === "string" &&
        /^[a-f0-9]{40}$/i.test(file.sha)
      ) {
        try {
          await this.cacheStore.put(file.sha, summary);
        } catch (error) {
          cacheWriteFailed = true;
          stats.cacheWriteFailures += 1;

          console.warn(
            `Could not cache the parse summary for ${file.path}.`,
            error
          );
        }
      }

      results[index] = {
        path: file.path,
        sha: file.sha ?? null,
        summary,
        fromCache,
        cacheWriteFailed,
        source: file.source ?? null
      };

      completed += 1;

      notifyProgress(onProgress, {
        phase: "parsing",
        done: completed,
        total: files.length,
        currentFile: file.path,
        status: summary.parseStatus,
        fromCache,
        cacheWriteFailed
      });
    };

    const runWorker = async (worker) => {
      while (true) {
        throwIfAborted(signal);

        // This synchronous increment assigns each index to one lane only.
        const index = nextIndex++;

        if (index >= files.length) {
          return;
        }

        await processOne(
          worker,
          files[index],
          index
        );
      }
    };

    try {
      await Promise.all(
        this.workers.map((worker) => runWorker(worker))
      );

      throwIfAborted(signal);

      return {
        results,
        stats
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Terminate every worker in this pool.
   *
   * @returns {void}
   */
  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    for (const worker of this.workers) {
      worker.destroy();
    }

    this.workers = [];
  }
}