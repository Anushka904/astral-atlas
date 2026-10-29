/**
 * Repository ingestion orchestrator for Astral Atlas.
 *
 * Responsibilities:
 * - Validate GitHub repository URLs.
 * - Resolve the requested/default branch and retrieve the recursive tree.
 * - Use Atlas Edge and an optional in-memory token after HTTP 403/429.
 * - Read tsconfig/jsconfig contents separately from source files.
 * - Apply source filters and the 2,000-file cap.
 * - Reuse parser summaries from IndexedDB and download missing source files.
 * - Support local ZIP ingestion through the same result model.
 *
 * Source files are fetched into the browser. Atlas Edge is used only for
 * repository metadata requests and never receives source-code contents here.
 */

import {
  parseGitHubRepoUrl,
  RepoUrlError
} from "./utils/url.js";

import {
  filterSourceTree,
  containsBinaryMarker,
  MAX_SOURCE_FILE_BYTES
} from "./utils/path.js";

import {
  fetchRawFile,
  getRepositoryMetadata,
  getRecursiveTree
} from "../services/githubApi.js";

import AtlasEdgeClient from "../services/atlasEdgeClient.js";
import FetchQueue from "./FetchQueue.js";
import CacheStore, {
  getParseCacheKey,
  rebaseCachedSummary
} from "./CacheStore.js";
import { readZipArchive } from "../services/zipService.js";

const MAX_PATH_CONFIG_BYTES = 100 * 1024;
const MAX_CONFIG_FILES = 32;

/**
 * Convert a failure into an actionable ingestion error.
 */
export class RepoLoadError extends Error {
  constructor(message, {
    code = "REPO_LOAD_FAILED",
    cause = null,
    details = null
  } = {}) {
    super(message);
    this.name = "RepoLoadError";
    this.code = code;
    this.cause = cause;
    this.details = details;
  }
}

/**
 * Invoke a UI callback without allowing it to break the ingestion pipeline.
 *
 * @param {Function|undefined} callback
 * @param {object} data
 * @param {string} label
 */
function safeCallback(callback, data, label) {
  if (typeof callback !== "function") {
    return;
  }

  try {
    callback(data);
  } catch (error) {
    console.error(`${label} callback failed.`, error);
  }
}

const SKIP_REASON_LABELS = Object.freeze({
  "invalid-path": { one: "invalid path", other: "invalid paths" },
  "outside-subpath": {
    one: "path outside the selected directory",
    other: "paths outside the selected directory"
  },
  "excluded-directory": {
    one: "path under an excluded dependency/build/vendor directory",
    other: "paths under excluded dependency/build/vendor directories"
  },
  "hidden-file": { one: "hidden file", other: "hidden files" },
  minified: { one: "minified file", other: "minified files" },
  "too-large": {
    one: "file over the size limit",
    other: "files over the size limit"
  },
  "unsupported-extension": {
    one: "unsupported file extension",
    other: "unsupported file extensions"
  },
  "file-cap": {
    one: "eligible file beyond the analysis limit",
    other: "eligible files beyond the analysis limit"
  },
  symlink: {
    one: "symbolic link not followed",
    other: "symbolic links not followed"
  },
  "invalid-entry": {
    one: "invalid archive entry",
    other: "invalid archive entries"
  },
  "config-too-large": {
    one: "oversized path configuration file",
    other: "oversized path configuration files"
  },
  "binary-config": {
    one: "binary path configuration file",
    other: "binary path configuration files"
  },
  "binary-content": {
    one: "file with binary content",
    other: "files with binary content"
  },
  "hash-failure": {
    one: "file whose content hash could not be computed",
    other: "files whose content hash could not be computed"
  }
});

/**
 * Turn skip counters into a concise explanation for the analysis warning.
 * The counters remain available as structured data on the loader result.
 *
 * @param {Record<string,number>} skippedByReason
 * @returns {string}
 */
function formatSkippedReasons(skippedByReason) {
  return Object.entries(skippedByReason ?? {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort(([reasonA, countA], [reasonB, countB]) =>
      countB - countA || reasonA.localeCompare(reasonB)
    )
    .map(([reason, count]) => {
      const labels = SKIP_REASON_LABELS[reason];
      const label = labels
        ? count === 1 ? labels.one : labels.other
        : reason;

      return `${count.toLocaleString()} ${label}`;
    })
    .join(", ");
}

/**
 * Abort immediately when the user has cancelled the operation.
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Cancelled.", "AbortError");
  }
}

/**
 * Convert an upstream failure into a user-facing message.
 *
 * @param {Error} error
 * @param {string} phase
 * @returns {Error}
 */
function friendlyError(error, phase) {
  if (error instanceof RepoLoadError) {
    return error;
  }

  if (error instanceof RepoUrlError) {
    return new RepoLoadError(error.message, {
      code: error.code,
      cause: error
    });
  }

  if (error?.name === "AbortError") {
    return error;
  }

  const status = Number(error?.status);

  if (status === 404) {
    return new RepoLoadError(
      "Repository not found, or it is private. Astral Atlas currently supports public GitHub repositories only.",
      {
        code: "REPO_NOT_FOUND_OR_PRIVATE",
        cause: error
      }
    );
  }

  if (status === 401) {
    return new RepoLoadError(
      "GitHub rejected the request. Check the repository URL and any optional token you supplied.",
      {
        code: "GITHUB_UNAUTHORIZED",
        cause: error
      }
    );
  }

  if (
    status === 403 ||
    status === 429 ||
    error?.rateLimited
  ) {
    return new RepoLoadError(
      "GitHub rejected the metadata request with HTTP 403 or 429. This may be a rate limit or another access restriction. Try Atlas Edge, an optional in-memory token, or ZIP upload.",
      {
        code: "GITHUB_RATE_LIMITED",
        cause: error
      }
    );
  }

  if (error?.name === "NetworkError") {
    return new RepoLoadError(
      "Astral Atlas couldn't reach GitHub. Check your internet connection or use a ZIP archive.",
      {
        code: "NETWORK_ERROR",
        cause: error
      }
    );
  }

  if (phase === "tree") {
    return new RepoLoadError(
      "The repository tree could not be loaded. Verify that the repository is public and try again.",
      {
        code: "TREE_LOAD_FAILED",
        cause: error
      }
    );
  }

  return new RepoLoadError(
    error?.message ||
      "The repository could not be loaded. Please try again.",
    {
      code: "REPO_LOAD_FAILED",
      cause: error
    }
  );
}

/**
 * Choose path configuration files from a GitHub tree.
 *
 * Tree entries are metadata only. The configuration file contents are
 * fetched separately in loadPathConfigFiles().
 *
 * @param {Array<object>} tree
 * @returns {Array<object>}
 */
export function findPathConfigEntries(tree) {
  const entries = (Array.isArray(tree) ? tree : [])
    .filter((entry) => {
      if (entry.type !== "blob") {
        return false;
      }

      const fileName = String(entry.path ?? "")
        .split("/")
        .at(-1)
        .toLowerCase();

      if (
        fileName !== "tsconfig.json" &&
        fileName !== "jsconfig.json"
      ) {
        return false;
      }

      // Reject obviously oversized files based on tree metadata before
      // requesting their content. Unknown sizes are checked after download.
      return (
        !Number.isFinite(entry.size) ||
        entry.size <= MAX_PATH_CONFIG_BYTES
      );
    });

  entries.sort((a, b) => {
    const aTs = a.path.toLowerCase().endsWith("tsconfig.json");
    const bTs = b.path.toLowerCase().endsWith("tsconfig.json");

    if (aTs !== bTs) {
      return aTs ? -1 : 1;
    }

    const depthDifference =
      a.path.split("/").length -
      b.path.split("/").length;

    return depthDifference || a.path.localeCompare(b.path);
  });

  return entries.slice(0, MAX_CONFIG_FILES);
}

/**
 * Fetch selected path configuration files from GitHub.
 *
 * @param {object} repo
 * @param {string} branch
 * @param {Array<object>} tree
 * @param {{
 *   token?:string,
 *   signal?:AbortSignal,
 *   fetchQueue?:FetchQueue,
 *   onProgress?:(event:object)=>void
 * }} [options]
 * @returns {Promise<{configFiles:Array<object>,warnings:string[]}>}
 */
export async function loadPathConfigFiles(
  repo,
  branch,
  tree,
  {
    token,
    signal,
    fetchQueue = new FetchQueue({ concurrency: 4 }),
    onProgress
  } = {}
) {
  const candidates = findPathConfigEntries(tree);
  const configFiles = [];
  const warnings = [];

  if (candidates.length === 0) {
    return { configFiles, warnings };
  }

  const oversized = (tree ?? []).filter((entry) => {
    const fileName = String(entry.path ?? "")
      .split("/")
      .at(-1)
      .toLowerCase();

    return (
      ["tsconfig.json", "jsconfig.json"].includes(fileName) &&
      Number.isFinite(entry.size) &&
      entry.size > MAX_PATH_CONFIG_BYTES
    );
  });

  if (oversized.length > 0) {
    warnings.push(
      `${oversized.length} path configuration file(s) exceeded the 100 KB configuration limit and were ignored.`
    );
  }

  const result = await fetchQueue.run(
    candidates,
    async (entry, { signal: taskSignal }) => {
      const content = await fetchRawFile(
        repo.owner,
        repo.repo,
        branch,
        entry.path,
        {
          token,
          signal: taskSignal
        }
      );

      const byteLength = new TextEncoder()
        .encode(content)
        .byteLength;

      if (byteLength > MAX_PATH_CONFIG_BYTES) {
        const error = new Error(
          "The path configuration exceeds the 100 KB limit."
        );

        error.code = "PATH_CONFIG_TOO_LARGE";

        throw error;
      }

      // Return data, never put the config into the AST parser input.
      return {
        path: entry.path,
        content
      };
    },
    {
      signal,
      onProgress: (event) => {
        safeCallback(
          onProgress,
          {
            ...event,
            stage: "reading-config"
          },
          "Configuration progress"
        );
      }
    }
  );

  for (const item of result) {
    if (item.status === "fulfilled") {
      configFiles.push(item.value);
    } else {
      warnings.push(
        `Could not load path configuration ${item.item.path}: ${item.reason?.message ?? "request failed"}.`
      );
    }
  }

  if (
    candidates.length > 0 &&
    configFiles.length === 0
  ) {
    warnings.push(
      "No path configuration files could be loaded. Imports will be resolved without tsconfig/jsconfig aliases."
    );
  }

  return {
    configFiles,
    warnings
  };
}

export default class RepoLoader {
  /**
   * @param {{
   *   cacheStore?:CacheStore,
   *   fetchQueue?:FetchQueue,
   *   edgeClient?:AtlasEdgeClient,
   *   edgeUrl?:string
   * }} [options]
   */
  constructor({
    cacheStore = new CacheStore(),
    fetchQueue = new FetchQueue({ concurrency: 6 }),
    edgeClient,
    edgeUrl = ""
  } = {}) {
    this.cacheStore = cacheStore;
    this.fetchQueue = fetchQueue;

    this.edgeClient =
      edgeClient ??
      new AtlasEdgeClient({ baseUrl: edgeUrl });
  }

  /**
   * Resolve an explicit branch or discover the repository default branch.
   *
   * The metadata endpoint isn't relayed by Atlas Edge in this architecture,
   * so an optional token can retry a rate-limited metadata request.
   *
   * @param {object} repo
   * @param {{token?:string,signal?:AbortSignal}} [options]
   * @returns {Promise<string>}
   */
  async resolveBranch(repo, {
    token,
    signal
  } = {}) {
    if (repo.branch) {
      return repo.branch;
    }

    try {
      const metadata = await getRepositoryMetadata(
        repo.owner,
        repo.repo,
        { signal }
      );

      return metadata.default_branch;
    } catch (firstError) {
      if (firstError?.name === "AbortError") {
        throw firstError;
      }

      if (
        (
          firstError?.rateLimited ||
          firstError?.status === 403 ||
          firstError?.status === 429
        ) &&
        token?.trim()
      ) {
        try {
          const metadata = await getRepositoryMetadata(
            repo.owner,
            repo.repo,
            { token, signal }
          );

          return metadata.default_branch;
        } catch (tokenError) {
          throw friendlyError(tokenError, "metadata");
        }
      }

      throw friendlyError(firstError, "metadata");
    }
  }

  /**
   * Get the recursive file tree with the intended fallback order.
   *
   * @param {object} repo
   * @param {string} branch
   * @param {{token?:string,signal?:AbortSignal}} [options]
   * @returns {Promise<object>}
   */
  async fetchTreeWithFallback(repo, branch, {
    token,
    signal
  } = {}) {
    try {
      return await getRecursiveTree(
        repo.owner,
        repo.repo,
        branch,
        { signal }
      );
    } catch (directError) {
      if (directError?.name === "AbortError") {
        throw directError;
      }

      // A 403 may lack rate-limit headers. The HTTP status itself is a
      // fallback trigger, although it can also represent another restriction.
      const shouldTryFallback =
        directError?.rateLimited === true ||
        directError?.status === 403 ||
        directError?.status === 429;

      if (!shouldTryFallback) {
        throw friendlyError(directError, "tree");
      }

      let edgeError = null;

      if (this.edgeClient?.configured) {
        try {
          return await this.edgeClient.getTree(
            repo.owner,
            repo.repo,
            branch,
            { signal }
          );
        } catch (error) {
          if (error?.name === "AbortError") {
            throw error;
          }

          edgeError = error;
        }
      }

      if (token?.trim()) {
        try {
          return await getRecursiveTree(
            repo.owner,
            repo.repo,
            branch,
            { token, signal }
          );
        } catch (tokenError) {
          if (tokenError?.name === "AbortError") {
            throw tokenError;
          }

          throw friendlyError(tokenError, "tree");
        }
      }

      throw new RepoLoadError(
        this.edgeClient?.configured
          ? "GitHub returned HTTP 403 or 429, and Atlas Edge could not provide the tree. Try a personal token kept in memory or upload a ZIP."
          : "GitHub returned HTTP 403 or 429. Atlas Edge isn't configured yet; try a personal token kept in memory or upload a ZIP.",
        {
          code: "GITHUB_RATE_LIMITED",
          cause: edgeError ?? directError
        }
      );
    }
  }

  /**
   * Load a GitHub repository and prepare its JS/TS files and path configs.
   *
   * The returned configFiles are deliberately separate from files: they are
   * passed to GraphBuilder, not to the source parser.
   *
   * @param {string} input
   * @param {{
   *   token?:string,
   *   signal?:AbortSignal,
   *   onStage?:(event:object)=>void,
   *   onProgress?:(event:object)=>void
   * }} [options]
   * @returns {Promise<object>}
   */
  async loadFromGitHub(input, {
    token,
    signal,
    onStage,
    onProgress
  } = {}) {
    throwIfAborted(signal);

    let repo;

    try {
      repo = parseGitHubRepoUrl(input);
    } catch (error) {
      throw friendlyError(error, "url");
    }

    safeCallback(onStage, {
      stage: "listing",
      message: "Listing repository files",
      repo: repo.fullName
    }, "Stage");

    const branch = await this.resolveBranch(repo, {
      token,
      signal
    });

    throwIfAborted(signal);

    const resolvedRepo = {
      ...repo,
      branch,
      source: "github"
    };

    const treeData = await this.fetchTreeWithFallback(
      resolvedRepo,
      branch,
      { token, signal }
    );

    throwIfAborted(signal);

    safeCallback(onStage, {
      stage: "filtering",
      message: "Filtering source files",
      totalEntries: treeData.tree.length
    }, "Stage");

    const filtered = filterSourceTree(treeData.tree, {
      subpath: repo.subpath
    });

    const warnings = [];

    if (treeData.truncated) {
      warnings.push(
        "GitHub marked the recursive tree as truncated. Only the paths returned by GitHub can be analysed; upload a ZIP archive for a local alternative."
      );
    }

    if (filtered.capApplied) {
      warnings.push(
        "The repository contains more than 2,000 eligible source files. The analysis input has been capped at 2,000 files."
      );
    }

    if (filtered.skippedCount > 0) {
      const reasonSummary = formatSkippedReasons(
        filtered.skippedByReason
      );

      warnings.push(
        `Source-file filtering excluded ${filtered.skippedCount.toLocaleString()} path${
          filtered.skippedCount === 1 ? "" : "s"
        }${reasonSummary ? ` (${reasonSummary})` : ""}. ` +
        "Path configuration files can still be loaded separately for alias resolution."
      );
    }

    if (filtered.files.length === 0) {
      throw new RepoLoadError(
        "No supported JavaScript or TypeScript source files were found in this repository or selected directory.",
        {
          code: "NO_SOURCE_FILES",
          details: {
            repo: resolvedRepo,
            skippedByReason: filtered.skippedByReason
          }
        }
      );
    }

    // Read tsconfig/jsconfig files separately. These are configuration
    // inputs for GraphBuilder, not source files for Babel.
    safeCallback(onStage, {
      stage: "reading-config",
      message: "Loading path-alias configuration files"
    }, "Stage");

    const configResult = await loadPathConfigFiles(
      resolvedRepo,
      branch,
      treeData.tree,
      {
        token,
        signal,
        fetchQueue: new FetchQueue({
          concurrency: 4,
          maxRetries: 2
        }),
        onProgress
      }
    );

    warnings.push(...configResult.warnings);

    throwIfAborted(signal);

    safeCallback(onStage, {
      stage: "checking-cache",
      message: "Checking the local analysis cache",
      total: filtered.files.length
    }, "Stage");

    let cachedSummaries = new Map();
    let cacheAvailable = true;

    try {
      cachedSummaries = await this.cacheStore.getMany(
        filtered.files.map((file) => ({
          sha: file.sha,
          path: file.path
        }))
      );
    } catch (error) {
      cacheAvailable = false;
      warnings.push(
        "Local caching is unavailable in this browser session. The run will continue without cache reuse."
      );

      console.warn("Cache lookup failed.", error);
    }

    const files = filtered.files.map((file) => {
      // A content-identical file can appear at several paths. Cached parser
      // metadata is content-derived, so always restore the current path/SHA
      // before GraphBuilder consumes it.
      const cachedSummary =
        cachedSummaries.get(getParseCacheKey(file.sha, file.path)) ??
        cachedSummaries.get(file.sha) ??
        null;

      return {
        ...file,
        content: null,
        cachedSummary: rebaseCachedSummary(cachedSummary, file),
        source: "github",
        loadError: null
      };
    });

    const filesToDownload = files.filter(
      (file) => file.cachedSummary === null
    );

    safeCallback(onStage, {
      stage: "downloading",
      message: "Downloading files missing from the cache",
      total: filesToDownload.length
    }, "Stage");

    let downloadResults = [];

    try {
      downloadResults = await this.fetchQueue.run(
        filesToDownload,
        async (file, { signal: taskSignal }) => {
          const content = await fetchRawFile(
            resolvedRepo.owner,
            resolvedRepo.repo,
            branch,
            file.path,
            {
              token,
              signal: taskSignal
            }
          );

          const bytes = new TextEncoder().encode(content);

          if (bytes.byteLength > MAX_SOURCE_FILE_BYTES) {
            const error = new Error(
              "The downloaded source file exceeds the 300 KB limit."
            );

            error.code = "FILE_TOO_LARGE";
            throw error;
          }

          if (containsBinaryMarker(bytes)) {
            const error = new Error(
              "The downloaded file contains binary data."
            );

            error.code = "BINARY_SOURCE_FILE";
            throw error;
          }

          return content;
        },
        {
          signal,
          onProgress: (event) => {
            safeCallback(
              onProgress,
              {
                ...event,
                stage: "downloading"
              },
              "Progress"
            );
          }
        }
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }

      throw new RepoLoadError(
        "The download queue could not finish. Please try again.",
        {
          code: "DOWNLOAD_QUEUE_FAILED",
          cause: error
        }
      );
    }

    let downloadedCount = 0;
    const failedFiles = [];

    for (const item of downloadResults) {
      const file = filesToDownload[item.index];

      if (item.status === "fulfilled") {
        file.content = item.value;
        downloadedCount += 1;
      } else {
        const message =
          item.reason?.message ??
          "The source file could not be downloaded.";

        file.loadError = message;

        failedFiles.push({
          path: file.path,
          sha: file.sha,
          message,
          status: item.reason?.status ?? null
        });
      }
    }

    const result = {
      repo: resolvedRepo,
      files,
      configFiles: configResult.configFiles,
      warnings,
      failedFiles,
      skippedByReason: filtered.skippedByReason,
      truncated: treeData.truncated === true,
      capApplied: filtered.capApplied,
      cacheAvailable,
      stats: {
        totalTreeEntries: treeData.tree.length,
        candidateCount: filtered.candidateCount,
        eligibleFiles: filtered.files.length,
        configurationFiles: configResult.configFiles.length,
        cacheHits: files.filter(
          (file) => file.cachedSummary !== null
        ).length,
        cacheMisses: filesToDownload.length,
        downloadedFiles: downloadedCount,
        failedFiles: failedFiles.length,
        skippedFiles: filtered.skippedCount
      }
    };

    try {
      await this.cacheStore.rememberRepo(resolvedRepo);
    } catch (error) {
      console.warn(
        "Recent repository history could not be updated.",
        error
      );

      warnings.push(
        "The repository loaded, but recent history could not be saved."
      );
    }

    return result;
  }

  /**
   * Prepare a local ZIP archive.
   *
   * Path configuration files remain separate from parser input.
   *
   * @param {File} file
   * @param {{
   *   signal?:AbortSignal,
   *   onStage?:(event:object)=>void,
   *   onProgress?:(event:object)=>void
   * }} [options]
   * @returns {Promise<object>}
   */
  async loadFromZip(file, {
    signal,
    onStage,
    onProgress
  } = {}) {
    throwIfAborted(signal);

    safeCallback(onStage, {
      stage: "listing",
      message: "Inspecting the local ZIP archive",
      source: "zip"
    }, "Stage");

    const archive = await readZipArchive(file, {
      signal,
      onProgress: (event) => {
        safeCallback(
          onProgress,
          {
            ...event,
            stage: "zip-processing"
          },
          "Progress"
        );
      }
    });

    throwIfAborted(signal);

    if (archive.files.length === 0) {
      throw new RepoLoadError(
        "The ZIP contains no supported JavaScript or TypeScript source files within the current limits.",
        {
          code: "NO_SOURCE_FILES",
          details: {
            skippedByReason: archive.skippedByReason
          }
        }
      );
    }

    safeCallback(onStage, {
      stage: "checking-cache",
      message: "Checking the local analysis cache",
      total: archive.files.length
    }, "Stage");

    let cachedSummaries = new Map();
    let cacheAvailable = true;
    const warnings = [...(archive.warnings ?? [])];

    try {
      cachedSummaries = await this.cacheStore.getMany(
        archive.files.map((item) => ({
          sha: item.sha,
          path: item.path
        }))
      );
    } catch (error) {
      cacheAvailable = false;
      warnings.push(
        "Local caching is unavailable in this browser session. ZIP ingestion will continue without cache reuse."
      );

      console.warn("ZIP cache lookup failed.", error);
    }

    if (archive.capApplied) {
      warnings.push(
        "The archive contains more than 2,000 eligible source files. Only the first 2,000 eligible files were selected."
      );
    }

    if (archive.skippedCount > 0) {
      const reasonSummary = formatSkippedReasons(
        archive.skippedByReason
      );

      warnings.push(
        `ZIP filtering skipped ${archive.skippedCount.toLocaleString()} item${
          archive.skippedCount === 1 ? "" : "s"
        }${reasonSummary ? ` (${reasonSummary})` : ""}. ` +
        "Path configuration files can still be loaded separately for alias resolution."
      );
    }

    const files = archive.files.map((item) => {
      const cachedSummary =
        cachedSummaries.get(getParseCacheKey(item.sha, item.path)) ??
        cachedSummaries.get(item.sha) ??
        null;

      return {
        ...item,
        cachedSummary: rebaseCachedSummary(cachedSummary, item),
        source: "zip",
        loadError: null
      };
    });

    const repo = {
      owner: null,
      repo: file.name,
      fullName: file.name,
      branch: null,
      subpath: "",
      url: null,
      source: "zip"
    };

    try {
      await this.cacheStore.rememberRepo(repo);
    } catch (error) {
      console.warn(
        "Could not save the ZIP to recent history.",
        error
      );

      warnings.push(
        "The ZIP was prepared, but recent history could not be saved."
      );
    }

    return {
      repo,
      files,
      configFiles: archive.configFiles ?? [],
      warnings,
      failedFiles: [],
      skippedByReason: archive.skippedByReason,
      truncated: false,
      capApplied: archive.capApplied,
      cacheAvailable,
      stats: {
        totalTreeEntries: archive.totalEntries,
        candidateCount: archive.candidateCount,
        eligibleFiles: files.length,
        configurationFiles: archive.configFiles?.length ?? 0,
        cacheHits: files.filter(
          (item) => item.cachedSummary !== null
        ).length,
        cacheMisses: files.filter(
          (item) => item.cachedSummary === null
        ).length,
        downloadedFiles: 0,
        failedFiles: 0,
        skippedFiles: archive.skippedCount,
        expandedBytes: archive.expandedBytes
      }
    };
  }

  /**
   * Retrieve a source file on demand, for example when a cached summary
   * exists but a code panel needs the actual source text.
   *
   * @param {object} repo
   * @param {object} file
   * @param {{signal?:AbortSignal,token?:string}} [options]
   * @returns {Promise<string>}
   */
  async fetchFileContent(
    repo,
    file,
    { signal, token } = {}
  ) {
    throwIfAborted(signal);

    if (typeof file.content === "string") {
      return file.content;
    }

    if (repo.source === "zip") {
      throw new RepoLoadError(
        "The source content for this ZIP file is no longer in memory. Upload the ZIP again to browse its code.",
        {
          code: "ZIP_SOURCE_UNAVAILABLE"
        }
      );
    }

    try {
      const content = await fetchRawFile(
        repo.owner,
        repo.repo,
        repo.branch,
        file.path,
        {
          signal,
          token
        }
      );

      const size = new TextEncoder()
        .encode(content)
        .byteLength;

      if (size > MAX_SOURCE_FILE_BYTES) {
        throw new RepoLoadError(
          "This source file exceeds the 300 KB limit.",
          {
            code: "FILE_TOO_LARGE"
          }
        );
      }

      file.content = content;
      return content;
    } catch (error) {
      throw friendlyError(error, "source");
    }
  }
}
