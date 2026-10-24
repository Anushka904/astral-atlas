/**
 * Repository ingestion orchestrator for Astral Atlas.
 *
 * WHY:
 * - One class coordinates loading and progress reporting.
 * - GitHub, Edge, ZIP, cache, and queue logic stay in focused modules.
 * - ASTs are never created or transferred by this class.
 * - Individual file failures do not abort the entire repository load.
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
import CacheStore from "./CacheStore.js";
import { readZipArchive } from "../services/zipService.js";

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
 * Notify the UI without allowing a broken callback to stop ingestion.
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

/**
 * Stop a pipeline operation when the caller cancels it.
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
 * Convert technical failures into actionable messages for the UI.
 *
 * @param {Error} error
 * @param {string} phase
 * @returns {Error}
 */
function friendlyError(error, phase) {
  if (
    error instanceof RepoLoadError ||
    error instanceof RepoUrlError
  ) {
    return error instanceof RepoLoadError
      ? error
      : new RepoLoadError(error.message, {
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
      "GitHub rejected the request. Check the repository URL and, if using a personal token, verify that it is valid.",
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
      "GitHub rejected the metadata request with HTTP 403 or 429. This may be a rate limit or another access restriction. Try Atlas Edge, an optional in-memory personal token, or ZIP upload.",
      {
        code: "GITHUB_RATE_LIMITED",
        cause: error
      }
    );
  }

  if (error?.name === "NetworkError") {
    return new RepoLoadError(
      "Astral Atlas couldn't reach GitHub. Check your internet connection and try again, or use a ZIP archive.",
      {
        code: "NETWORK_ERROR",
        cause: error
      }
    );
  }

  if (phase === "tree") {
    return new RepoLoadError(
      "The repository file tree could not be loaded. Check that the repository is public and try again.",
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
 * Coordinate public GitHub and local ZIP ingestion.
 */
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
    fetchQueue = new FetchQueue({
      concurrency: 6
    }),
    edgeClient,
    edgeUrl = ""
  } = {}) {
    this.cacheStore = cacheStore;
    this.fetchQueue = fetchQueue;

    this.edgeClient =
      edgeClient ??
      new AtlasEdgeClient({
        baseUrl: edgeUrl
      });
  }

  /**
   * Resolve the requested branch.
   *
   * Explicit /tree/branch URLs avoid the metadata request. Otherwise,
   * GitHub's default branch is obtained from repository metadata.
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

      const shouldRetryWithToken =
        firstError?.rateLimited ||
        firstError?.status === 403 ||
        firstError?.status === 429;

      if (shouldRetryWithToken && token?.trim()) {
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
   * Fetch a recursive Git tree.
   *
   * Fallback order:
   * 1. Direct GitHub request.
   * 2. Atlas Edge for HTTP 403 or 429.
   * 3. Optional in-memory personal token.
   * 4. Ask the user to upload a ZIP if metadata access remains unavailable.
   *
   * A generic HTTP failure or network failure does not automatically trigger
   * the rate-limit fallback chain.
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

      /*
       * IMPORTANT CORRECTION:
       * Some GitHub 403 responses omit clear rate-limit headers.
       * Therefore, do not rely on rateLimited alone before attempting Edge.
       */
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

      const cause = edgeError ?? directError;

      const message = this.edgeClient?.configured
        ? "GitHub returned HTTP 403 or 429, and Atlas Edge could not provide the repository tree. Try an optional personal token kept in memory, or upload a ZIP archive."
        : "GitHub returned HTTP 403 or 429. Atlas Edge is not configured yet; try an optional personal token kept in memory, or upload a ZIP archive.";

      throw new RepoLoadError(message, {
        code: "GITHUB_RATE_LIMITED",
        cause
      });
    }
  }

  /**
   * Load a public GitHub repository.
   *
   * Cached summaries are reused. Only cache misses are downloaded.
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

    safeCallback(
      onStage,
      {
        stage: "listing",
        message: "Listing repository files",
        repo: repo.fullName
      },
      "Stage"
    );

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

    safeCallback(
      onStage,
      {
        stage: "filtering",
        message: "Filtering source files",
        totalEntries: treeData.tree.length
      },
      "Stage"
    );

    const filtered = filterSourceTree(
      treeData.tree,
      {
        subpath: repo.subpath
      }
    );

    const warnings = [];

    if (treeData.truncated) {
      warnings.push(
        "GitHub marked the recursive tree as truncated. The atlas can only include the paths returned by GitHub. Upload a ZIP archive for a local alternative."
      );
    }

    if (filtered.capApplied) {
      warnings.push(
        "The repository contains more than 2,000 eligible source files. The analysis input has been capped at 2,000 files."
      );
    }

    if (filtered.skippedCount > 0) {
      warnings.push(
        `${filtered.skippedCount.toLocaleString()} paths were skipped by source-file filters or repository limits.`
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

    safeCallback(
      onStage,
      {
        stage: "checking-cache",
        message: "Checking the local analysis cache",
        total: filtered.files.length
      },
      "Stage"
    );

    let cachedSummaries = new Map();
    let cacheAvailable = true;

    try {
      cachedSummaries = await this.cacheStore.getMany(
        filtered.files.map((file) => file.sha)
      );
    } catch (error) {
      cacheAvailable = false;

      warnings.push(
        "Local caching is unavailable in this browser session. The run will continue without cache reuse."
      );

      console.warn("Cache lookup failed.", error);
    }

    const files = filtered.files.map((file) => ({
      ...file,
      content: null,
      cachedSummary: cachedSummaries.get(file.sha) ?? null,
      source: "github",
      loadError: null
    }));

    const filesToDownload = files.filter(
      (file) => file.cachedSummary === null
    );

    let downloadResults = [];
    let downloadedCount = 0;
    const failedFiles = [];

    safeCallback(
      onStage,
      {
        stage: "downloading",
        message: "Downloading files missing from the cache",
        total: filesToDownload.length
      },
      "Stage"
    );

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

    for (const downloadResult of downloadResults) {
      const file = filesToDownload[downloadResult.index];

      if (downloadResult.status === "fulfilled") {
        file.content = downloadResult.value;
        downloadedCount += 1;
      } else {
        const message =
          downloadResult.reason?.message ??
          "The source file could not be downloaded.";

        file.loadError = message;

        failedFiles.push({
          path: file.path,
          sha: file.sha,
          message,
          status: downloadResult.reason?.status ?? null
        });
      }
    }

    const result = {
      repo: resolvedRepo,
      files,
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
   * Load a ZIP file using the same result shape as GitHub ingestion.
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

    safeCallback(
      onStage,
      {
        stage: "listing",
        message: "Inspecting the local ZIP archive",
        source: "zip"
      },
      "Stage"
    );

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

    safeCallback(
      onStage,
      {
        stage: "checking-cache",
        message: "Checking the local analysis cache",
        total: archive.files.length
      },
      "Stage"
    );

    let cachedSummaries = new Map();
    let cacheAvailable = true;

    const warnings = [];

    try {
      cachedSummaries = await this.cacheStore.getMany(
        archive.files.map((file) => file.sha)
      );
    } catch (error) {
      cacheAvailable = false;

      warnings.push(
        "Local caching is unavailable in this browser session. ZIP analysis will continue without cache reuse."
      );

      console.warn("ZIP cache lookup failed.", error);
    }

    if (archive.capApplied) {
      warnings.push(
        "The archive contains more than 2,000 eligible source files. Only the first 2,000 eligible files were selected."
      );
    }

    if (archive.skippedCount > 0) {
      warnings.push(
        `${archive.skippedCount.toLocaleString()} archive entries or source files were skipped.`
      );
    }

    const files = archive.files.map((file) => ({
      ...file,
      cachedSummary: cachedSummaries.get(file.sha) ?? null,
      source: "zip",
      loadError: null
    }));

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
   * Retrieve source text if it was not downloaded during ingestion.
   *
   * This is useful when an AST summary is cached but the code panel needs
   * to display the selected file.
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

      const size = new TextEncoder().encode(content).byteLength;

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