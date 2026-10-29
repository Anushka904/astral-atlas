/**
 * Main orchestration controller for Astral Atlas.
 *
 * WHY:
 * React should render the current application state, not perform repository
 * ingestion, AST parsing, graph construction or analysis itself.
 *
 * This controller coordinates the complete pipeline and reports progress
 * through an optional state callback.
 */

import RepoLoader from "./RepoLoader.js";
import ParserPool from "./ParserPool.js";
import CacheStore from "./CacheStore.js";
import GraphBuilder from "./GraphBuilder.js";
import CallResolver from "./CallResolver.js";
import CycleDetector from "./CycleDetector.js";
import BlastRadiusAnalyzer from "./BlastRadiusAnalyzer.js";

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createInitialState() {
  return {
    phase: "idle",
    isRunning: false,
    stage: null,
    message: "",
    progress: null,
    error: null,
    result: null,
    benchmark: {
      fetchMs: null,
      parseMs: null,
      graphMs: null,
      layoutMs: null,
      cacheHitRate: null,
      cacheHits: null,
      cacheMisses: null,
      fps: null
    }
  };
}

/**
 * Create a serializable description of an application-level error.
 *
 * @param {Error} error
 * @returns {{message:string,code:string|null,name:string}}
 */
function describeError(error) {
  return {
    message:
      error?.message ??
      "An unexpected error occurred while analysing the repository.",
    code: error?.code ?? null,
    name: error?.name ?? "Error"
  };
}

/**
 * Public repository-analysis orchestrator.
 */
export default class AppController {
  /**
   * @param {{
   *   onUpdate?:(state:object)=>void,
   *   edgeUrl?:string,
   *   dependencies?:{
   *     cacheStore?:object,
   *     repoLoader?:object,
   *     parserPool?:object,
   *     graphBuilder?:object,
   *     callResolver?:object,
   *     cycleDetector?:object,
   *     blastRadiusAnalyzer?:object
   *   }
   * }} [options]
   */
  constructor({
    onUpdate,
    edgeUrl = import.meta.env?.VITE_EDGE_URL ?? "",
    dependencies = {}
  } = {}) {
    this.onUpdate =
      typeof onUpdate === "function"
        ? onUpdate
        : null;

    // Sharing one CacheStore matters: the loader checks its summaries and
    // the parser pool writes back into the same IndexedDB cache.
    this.cacheStore =
      dependencies.cacheStore ??
      new CacheStore();

    this.repoLoader =
      dependencies.repoLoader ??
      new RepoLoader({
        cacheStore: this.cacheStore,
        edgeUrl
      });

    this.parserPool =
      dependencies.parserPool ??
      new ParserPool({
        cacheStore: this.cacheStore
      });

    this.graphBuilder =
      dependencies.graphBuilder ??
      new GraphBuilder();

    this.callResolver =
      dependencies.callResolver ??
      new CallResolver();

    this.cycleDetector =
      dependencies.cycleDetector ??
      new CycleDetector();

    this.blastRadiusAnalyzer =
      dependencies.blastRadiusAnalyzer ??
      new BlastRadiusAnalyzer();

    this.state = createInitialState();
    this.abortController = null;
    this.currentToken = null;
    this.lastLoaded = null;
    this.running = false;
    this.destroyed = false;
  }

  /**
   * Publish a partial state update to React or another consumer.
   *
   * @param {object} patch
   * @returns {object}
   */
  publish(patch) {
    this.state = {
      ...this.state,
      ...patch
    };

    if (this.onUpdate) {
      try {
        this.onUpdate({ ...this.state });
      } catch (error) {
        console.error(
          "Astral Atlas state callback failed.",
          error
        );
      }
    }

    return this.state;
  }

  /**
   * Update the current ingestion/analysis stage.
   *
   * @param {object} event
   */
  handleStage(event) {
    const stage = event.stage ?? this.state.stage;

    this.publish({
      stage,
      message: event.message ?? this.state.message,
      progress: null
    });
  }

  /**
   * Update the active stage's progress counters.
   *
   * @param {object} event
   */
  handleProgress(event) {
    this.publish({
      stage: event.stage ?? this.state.stage,
      progress: {
        ...event
      },
      message:
        event.currentFile ??
        event.message ??
        this.state.message
    });
  }

  /**
   * Analyse a GitHub URL.
   *
   * The optional token is retained only in this controller's memory.
   * It is never written to localStorage or IndexedDB by this class.
   *
   * @param {string} url
   * @param {{token?:string}} [options]
   * @returns {Promise<object|null>}
   */
  async analyzeGitHub(url, { token = "" } = {}) {
    this.currentToken = token.trim() || null;

    return this.runAnalysis(({ signal }) =>
      this.repoLoader.loadFromGitHub(url, {
        token: this.currentToken,
        signal,
        onStage: (event) => this.handleStage(event),
        onProgress: (event) => this.handleProgress(event)
      })
    );
  }

  /**
   * Analyse a ZIP archive selected from the user's computer.
   *
   * @param {File} file
   * @returns {Promise<object|null>}
   */
  async analyzeZip(file) {
    this.currentToken = null;

    return this.runAnalysis(({ signal }) =>
      this.repoLoader.loadFromZip(file, {
        signal,
        onStage: (event) => this.handleStage(event),
        onProgress: (event) => this.handleProgress(event)
      })
    );
  }

  /**
   * Execute the shared ingestion → parsing → graph-analysis pipeline.
   *
   * @param {(context:{signal:AbortSignal})=>Promise<object>} loadRepository
   * @returns {Promise<object>}
   */
  async runAnalysis(loadRepository) {
    if (this.destroyed) {
      throw new Error(
        "The application controller has been destroyed."
      );
    }

    if (this.running) {
      throw new Error(
        "A repository analysis is already in progress."
      );
    }

    this.running = true;
    this.abortController = new AbortController();

    const signal = this.abortController.signal;
    const totalStart = now();

    let loaded = null;

    try {
      this.cacheStore.resetStats?.();

      this.publish({
        phase: "running",
        isRunning: true,
        stage: "listing",
        message: "Preparing repository analysis",
        progress: null,
        result: null,
        error: null,
        benchmark: {
          fetchMs: null,
          parseMs: null,
          graphMs: null,
          layoutMs: null,
          cacheHitRate: null,
          cacheHits: null,
          cacheMisses: null,
          fps: null
        }
      });

      // Stage A: ingestion, configuration retrieval, cache lookup and
      // source downloads. The Loader reports its finer-grained progress.
      loaded = await loadRepository({ signal });

      this.lastLoaded = loaded;

      const fetchMs = now() - totalStart;

      if (!loaded || !Array.isArray(loaded.files)) {
        throw new Error(
          "The repository loader returned an invalid result."
        );
      }

      if (loaded.files.length === 0) {
        const error = new Error(
          "No eligible source files were found."
        );

        error.code = "NO_SOURCE_FILES";
        throw error;
      }

      if (signal.aborted) {
        throw signal.reason ??
          new DOMException("Cancelled.", "AbortError");
      }

      // Stage B: parse/cache summaries in Web Workers.
      this.publish({
        phase: "running",
        stage: "parsing",
        message: "Parsing source files in Web Workers",
        progress: {
          phase: "parsing",
          done: 0,
          total: loaded.files.length
        }
      });

      const parseStart = now();

      const parsed = await this.parserPool.parseFiles(
        loaded.files,
        {
          signal,
          onProgress: (event) => {
            this.handleProgress({
              ...event,
              stage: "parsing"
            });
          }
        }
      );

      const parseMs = now() - parseStart;

      if (signal.aborted) {
        throw signal.reason ??
          new DOMException("Cancelled.", "AbortError");
      }

      // Stage C: construct the graph and run the analysis algorithms.
      this.publish({
        phase: "running",
        stage: "building-graph",
        message: "Building dependencies and resolving calls",
        progress: null
      });

      const graphStart = now();

      const graph = this.graphBuilder.build(
        parsed,
        {
          configFiles: loaded.configFiles ?? [],
          repoName:
            loaded.repo?.fullName ??
            loaded.repo?.repo ??
            null,
          sourceKind: loaded.repo?.source ?? null,
          repoUrl: loaded.repo?.url ?? null,
          branch: loaded.repo?.branch ?? null
        }
      );

      const callResolution = this.callResolver.resolve(graph);
      const cycles = this.cycleDetector.detect(graph);

      const starterFiles =
        this.blastRadiusAnalyzer.rankStarterFiles(
          graph,
          { limit: 10 }
        );

      const graphMs = now() - graphStart;

      const cacheStats =
        this.cacheStore.getStats?.() ?? {};

      // Report a file-level hit rate. CacheStore's own counters deduplicate
      // content hashes, while the UI's question is how many of the files in
      // this repository avoided parsing. Identical files at multiple paths
      // therefore count as individual file cache hits here.
      const cacheTotal = Number.isFinite(parsed.stats?.total)
        ? parsed.stats.total
        : Math.max(0, Number(cacheStats.hits ?? 0) + Number(cacheStats.misses ?? 0));
      const cacheHits = Number.isFinite(parsed.stats?.cacheHits)
        ? Math.min(cacheTotal, Math.max(0, parsed.stats.cacheHits))
        : Number.isFinite(cacheStats.hits)
          ? Math.min(cacheTotal, Math.max(0, cacheStats.hits))
          : null;
      const cacheMisses = cacheHits === null
        ? null
        : Math.max(0, cacheTotal - cacheHits);
      const cacheHitRate = cacheTotal > 0 && cacheHits !== null
        ? cacheHits / cacheTotal
        : null;

      const graphStats = {
        ...graph.getStats(),
        cycleGroups: cycles.cycles.length,
        cyclicFiles: cycles.cyclicNodes.length
      };

      const benchmark = {
        fetchMs: Math.round(fetchMs),
        parseMs: Math.round(parseMs),
        graphMs: Math.round(graphMs),
        layoutMs: null,
        cacheHitRate,
        cacheHits,
        cacheMisses,
        fps: null,
        generatedAt: new Date().toISOString()
      };

      const result = {
        repo: loaded.repo,
        loaded,
        parsed,
        graph,
        callResolution,
        cycles,
        starterFiles,
        stats: graphStats,
        benchmark
      };

      this.publish({
        phase: "complete",
        isRunning: false,
        stage: "laying-out",
        message: "Analysis complete. Preparing the atlas.",
        progress: null,
        error: null,
        result,
        benchmark
      });

      return result;
    } catch (error) {
      const cancelled =
        error?.name === "AbortError" ||
        signal.aborted;

      const finalError = cancelled
        ? {
            message: "Repository analysis was cancelled.",
            code: "ANALYSIS_CANCELLED",
            name: "AbortError"
          }
        : describeError(error);

      this.publish({
        phase: cancelled ? "cancelled" : "error",
        isRunning: false,
        message: finalError.message,
        progress: null,
        error: finalError
      });

      throw error;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  /**
   * Cancel the active run.
   *
   * @returns {void}
   */
  cancel() {
    if (!this.abortController) {
      return;
    }

    this.abortController.abort(
      new DOMException(
        "The user cancelled repository analysis.",
        "AbortError"
      )
    );

    this.publish({
      phase: "cancelled",
      isRunning: false,
      message: "Cancelling repository analysis.",
      progress: null
    });
  }

  /**
   * Return source code for the selected file, fetching it on demand only
   * when GitHub ingestion reused a cached summary.
   *
   * @param {string} path
   * @returns {Promise<string>}
   */
  async getSource(path) {
    if (!this.lastLoaded) {
      throw new Error(
        "No analysed repository is available."
      );
    }

    const file = this.lastLoaded.files.find(
      (item) => item.path === path
    );

    if (!file) {
      throw new Error(
        `Source file "${path}" is not available in this analysis.`
      );
    }

    if (typeof file.content === "string") {
      return file.content;
    }

    return this.repoLoader.fetchFileContent(
      this.lastLoaded.repo,
      file,
      {
        token: this.currentToken
      }
    );
  }

  /**
   * Record Cytoscape's measured layout duration.
   *
   * @param {number} milliseconds
   */
  recordLayoutMeasurement(milliseconds) {
    if (!Number.isFinite(milliseconds)) {
      return;
    }

    const benchmark = {
      ...this.state.benchmark,
      layoutMs: Math.round(milliseconds)
    };

    const result = this.state.result
      ? {
          ...this.state.result,
          benchmark
        }
      : null;

    this.publish({
      benchmark,
      result
    });
  }

  /**
   * Record the most recently measured browser frame rate.
   *
   * This is the UI's animation-frame rate, not a guarantee that every
   * Cytoscape layout calculation or paint completed at that frame rate.
   *
   * @param {number} fps
   */
  recordFps(fps) {
    if (!Number.isFinite(fps)) {
      return;
    }

    const benchmark = {
      ...this.state.benchmark,
      fps: Math.round(fps * 10) / 10
    };

    const result = this.state.result
      ? {
          ...this.state.result,
          benchmark
        }
      : null;

    this.publish({
      benchmark,
      result
    });
  }

  /**
   * Return the latest public application state.
   *
   * @returns {object}
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Reset the UI state and discard the in-memory optional token.
   *
   * @returns {void}
   */
  reset() {
    if (this.running) {
      this.cancel();
    }

    this.lastLoaded = null;
    this.currentToken = null;

    this.publish(createInitialState());
  }

  /**
   * Abort work and release worker resources.
   *
   * @returns {void}
   */
  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.abortController?.abort();
    this.parserPool.destroy?.();

    this.lastLoaded = null;
    this.currentToken = null;
  }
}