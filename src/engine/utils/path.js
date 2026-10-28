/**
 * Repository path normalization and source-file filtering.
 *
 * WHY: GitHub trees and ZIP archives must follow exactly the same
 * source-selection rules so their results are consistent.
 */

export const MAX_SOURCE_FILE_BYTES = 300 * 1024;
export const MAX_SOURCE_FILES = 2000;

export const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs"
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "vendor"
]);

const MINIFIED_PATTERN =
  /\.min\.(?:js|jsx|ts|tsx|mjs|cjs)$/i;

/**
 * Normalize a path from GitHub or a ZIP archive.
 * Unsafe absolute paths and parent-directory traversal are rejected.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeRepoPath(input) {
  if (typeof input !== "string" || !input.trim()) {
    return "";
  }

  const replaced = input.replace(/\\/g, "/");

  if (
    replaced.startsWith("/") ||
    /^[A-Za-z]:/.test(replaced)
  ) {
    return "";
  }

  const parts = replaced.split("/").filter(Boolean);

  if (
    parts.some((part) => part === "." || part === "..")
  ) {
    return "";
  }

  return parts.join("/");
}

/**
 * Get the final filename component.
 *
 * @param {string} path
 * @returns {string}
 */
export function getBaseName(path) {
  const normalized = normalizeRepoPath(path);
  return normalized.split("/").pop() ?? "";
}

/**
 * Return a reason why a source path should not be included.
 *
 * @param {string} inputPath
 * @param {number|null|undefined} size
 * @param {{maxFileBytes?: number}} [options]
 * @returns {string|null}
 */
export function getSourceSkipReason(
  inputPath,
  size,
  {
    maxFileBytes = MAX_SOURCE_FILE_BYTES
  } = {}
) {
  const path = normalizeRepoPath(inputPath);

  if (!path) {
    return "invalid-path";
  }

  const parts = path.split("/");
  const fileName = parts.at(-1);

  if (
    parts.some((part) =>
      EXCLUDED_DIRECTORIES.has(part.toLowerCase())
    )
  ) {
    return "excluded-directory";
  }

  if (fileName.startsWith(".") && fileName.length > 1) {
    return "hidden-file";
  }

  if (MINIFIED_PATTERN.test(fileName)) {
    return "minified";
  }

  if (
    typeof size === "number" &&
    Number.isFinite(size) &&
    size > maxFileBytes
  ) {
    return "too-large";
  }

  const extension = fileName.includes(".")
    ? `.${fileName.split(".").pop().toLowerCase()}`
    : "";

  if (!SOURCE_EXTENSIONS.has(extension)) {
    return "unsupported-extension";
  }

  return null;
}

/**
 * Check whether bytes contain a NUL character, a useful quick indicator
 * that a nominal source file contains binary data.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function containsBinaryMarker(bytes) {
  for (const byte of bytes) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Filter a GitHub recursive tree response.
 *
 * @param {Array<object>} tree
 * @param {{
 *   maxFileBytes?: number,
 *   maxFiles?: number,
 *   subpath?: string
 * }} [options]
 * @returns {{
 *   files: Array<object>,
 *   candidateCount: number,
 *   skippedCount: number,
 *   skippedByReason: Record<string, number>,
 *   capApplied: boolean
 * }}
 */
export function filterSourceTree(
  tree,
  {
    maxFileBytes = MAX_SOURCE_FILE_BYTES,
    maxFiles = MAX_SOURCE_FILES,
    subpath = ""
  } = {}
) {
  const skippedByReason = Object.create(null);
  const candidates = [];

  const addSkipped = (reason, count = 1) => {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    skippedByReason[reason] =
      (skippedByReason[reason] ?? 0) + Math.floor(count);
  };

  const normalizedSubpath = normalizeRepoPath(subpath);

  for (const entry of Array.isArray(tree) ? tree : []) {
    // Git trees include directories, submodules, and sometimes symlinks.
    // Directory/submodule records are not source-file paths for this count.
    if (entry.type !== "blob") {
      continue;
    }

    // Git mode 120000 identifies a symlink blob. It is deliberately not
    // followed, but it is still an omitted repository path and should be
    // accounted for in the coverage warning.
    if (entry.mode === "120000") {
      addSkipped("symlink");
      continue;
    }

    const path = normalizeRepoPath(entry.path);

    if (!path) {
      addSkipped("invalid-path");
      continue;
    }

    if (
      normalizedSubpath &&
      path !== normalizedSubpath &&
      !path.startsWith(`${normalizedSubpath}/`)
    ) {
      addSkipped("outside-subpath");
      continue;
    }

    const reason = getSourceSkipReason(path, entry.size, {
      maxFileBytes
    });

    if (reason) {
      addSkipped(reason);
      continue;
    }

    candidates.push({
      path,
      sha: entry.sha,
      size: entry.size ?? null,
      mode: entry.mode,
      type: entry.type
    });
  }

  const capApplied = candidates.length > maxFiles;
  const omittedByCap = Math.max(0, candidates.length - maxFiles);
  const files = candidates.slice(0, maxFiles);

  // Count every candidate excluded by the cap, not just the fact that the
  // cap was triggered. This keeps skippedCount and the UI warning accurate.
  if (omittedByCap > 0) {
    addSkipped("file-cap", omittedByCap);
  }

  return {
    files,
    candidateCount: candidates.length,
    skippedCount: Object.values(skippedByReason).reduce(
      (total, count) => total + count,
      0
    ),
    skippedByReason,
    capApplied
  };
}
