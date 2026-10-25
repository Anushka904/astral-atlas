/**
 * Local ZIP archive reader for Astral Atlas.
 *
 * WHY:
 * - ZIP ingestion must not require a network connection.
 * - Source files use the same filters and Git blob SHA as GitHub ingestion.
 * - tsconfig/jsconfig files are returned separately for GraphBuilder.
 * - Archive limits reduce the risk of excessive browser memory usage.
 */

import { unzipSync, strFromU8 } from "fflate";

import {
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  normalizeRepoPath,
  getSourceSkipReason,
  containsBinaryMarker
} from "../engine/utils/path.js";

import {
  computeGitBlobSha
} from "../engine/utils/blobSha.js";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_PATH_CONFIG_BYTES = 100 * 1024;

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

/**
 * Inspect the classic ZIP central directory before decompression.
 *
 * This deliberately rejects ZIP64 and encrypted entries rather than
 * attempting to process every possible ZIP variant.
 *
 * @param {Uint8Array} bytes
 * @returns {{entryCount:number,expandedBytes:number}}
 */
function inspectZipDirectory(bytes) {
  const minimumEndOffset = Math.max(
    0,
    bytes.length - 22 - 0xffff
  );

  let endOffset = -1;

  for (
    let offset = bytes.length - 22;
    offset >= minimumEndOffset;
    offset -= 1
  ) {
    if (
      offset >= 0 &&
      readUint32(bytes, offset) === 0x06054b50
    ) {
      endOffset = offset;
      break;
    }
  }

  if (endOffset < 0) {
    throw new Error(
      "This file does not contain a valid standard ZIP directory."
    );
  }

  const diskNumber = readUint16(bytes, endOffset + 4);
  const directoryDisk = readUint16(bytes, endOffset + 6);
  const entriesOnDisk = readUint16(bytes, endOffset + 8);
  const entryCount = readUint16(bytes, endOffset + 10);
  const directorySize = readUint32(bytes, endOffset + 12);
  const directoryOffset = readUint32(bytes, endOffset + 16);

  if (diskNumber !== 0 || directoryDisk !== 0) {
    throw new Error(
      "Multi-disk ZIP archives are not supported."
    );
  }

  if (
    entryCount === 0xffff ||
    entriesOnDisk === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error(
      "This ZIP uses ZIP64 metadata. Please provide a standard ZIP archive."
    );
  }

  if (
    entryCount !== entriesOnDisk ||
    entryCount > MAX_ARCHIVE_ENTRIES
  ) {
    throw new Error(
      "The ZIP entry count is inconsistent or exceeds the safety limit."
    );
  }

  if (
    directoryOffset + directorySize > endOffset ||
    directoryOffset + directorySize > bytes.length
  ) {
    throw new Error(
      "The ZIP central directory is invalid or incomplete."
    );
  }

  let cursor = directoryOffset;
  let expandedBytes = 0;

  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      readUint32(bytes, cursor) !== 0x02014b50
    ) {
      throw new Error(
        "The ZIP central directory contains an invalid entry."
      );
    }

    const flags = readUint16(bytes, cursor + 8);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const fileNameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);

    if (flags & 0x0001) {
      throw new Error(
        "Encrypted ZIP entries aren't supported. Upload an unencrypted archive."
      );
    }

    if (uncompressedSize === 0xffffffff) {
      throw new Error(
        "This ZIP uses ZIP64 file sizes, which aren't supported in this version."
      );
    }

    const headerEnd =
      cursor + 46 +
      fileNameLength +
      extraLength +
      commentLength;

    if (headerEnd > directoryOffset + directorySize) {
      throw new Error(
        "The ZIP central directory contains an incomplete entry."
      );
    }

    decoder.decode(
      bytes.subarray(
        cursor + 46,
        cursor + 46 + fileNameLength
      )
    );

    expandedBytes += uncompressedSize;

    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error(
        "This ZIP expands beyond the 100 MB safety limit."
      );
    }

    cursor = headerEnd;
  }

  return {
    entryCount,
    expandedBytes
  };
}

/**
 * Determine whether an entry is a path configuration file.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isPathConfigFile(path) {
  const name = path.split("/").at(-1).toLowerCase();

  return (
    name === "tsconfig.json" ||
    name === "jsconfig.json"
  );
}

/**
 * Strip a common wrapper directory from a typical repository ZIP.
 *
 * A single common directory is only stripped when the archive also has a
 * recognizable repository-root marker. This avoids mistakenly stripping an
 * actual source directory when the ZIP contains only files beneath src/.
 *
 * @param {string[]} paths
 * @returns {Map<string,string>}
 */
function makeRelativePathMap(paths) {
  const normalizedPaths = paths.map((original) => ({
    original,
    normalized: normalizeRepoPath(original)
  }));

  const validPaths = normalizedPaths.filter(
    (item) => item.normalized
  );

  const pathSegments = validPaths.map(
    ({ normalized }) => normalized.split("/")
  );

  const commonRoot = pathSegments[0]?.[0];

  const sharesSingleRoot =
    Boolean(commonRoot) &&
    pathSegments.every(
      (segments) =>
        segments.length > 1 &&
        segments[0] === commonRoot
    );

  const rootMarkers = new Set([
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "readme.md",
    ".gitignore",
    "license",
    "license.md",
    "license.txt",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json"
  ]);

  const hasRootMarker = sharesSingleRoot &&
    pathSegments.some((segments) =>
      rootMarkers.has(
        segments.slice(1)[0]?.toLowerCase() ?? ""
      )
    );

  const prefix = hasRootMarker
    ? `${commonRoot}/`
    : "";

  return new Map(
    validPaths.map(({ original, normalized }) => [
      original,
      prefix && normalized.startsWith(prefix)
        ? normalized.slice(prefix.length)
        : normalized
    ])
  );
}

/**
 * Safely notify ZIP progress listeners.
 *
 * @param {Function|undefined} callback
 * @param {object} event
 */
function reportProgress(callback, event) {
  if (typeof callback !== "function") {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    console.error("ZIP progress callback failed.", error);
  }
}

/**
 * Throw if archive ingestion has been cancelled.
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
 * Read a local ZIP archive and extract eligible JavaScript/TypeScript files.
 *
 * Result:
 * - `files`: source files with Git blob SHA and content
 * - `configFiles`: path configuration files for GraphBuilder
 *
 * @param {File} file
 * @param {{
 *   maxFileBytes?:number,
 *   maxFiles?:number,
 *   signal?:AbortSignal,
 *   onProgress?:(event:object)=>void
 * }} [options]
 * @returns {Promise<object>}
 */
export async function readZipArchive(file, {
  maxFileBytes = MAX_SOURCE_FILE_BYTES,
  maxFiles = MAX_SOURCE_FILES,
  signal,
  onProgress
} = {}) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new TypeError(
      "Choose a ZIP file from your computer."
    );
  }

  if (!/\.zip$/i.test(file.name || "")) {
    throw new Error(
      "That file isn't a ZIP archive. Choose a file ending in .zip."
    );
  }

  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      "This ZIP exceeds the 50 MB compressed archive limit."
    );
  }

  throwIfAborted(signal);

  const archiveBuffer = await file.arrayBuffer();
  const archiveBytes = new Uint8Array(archiveBuffer);
  const stats = inspectZipDirectory(archiveBytes);

  throwIfAborted(signal);

  let entries;

  try {
    entries = unzipSync(archiveBytes);
  } catch (error) {
    throw new Error(
      "The ZIP could not be extracted. It may be damaged or use an unsupported compression method.",
      { cause: error }
    );
  }

  throwIfAborted(signal);

  const archivePaths = Object.keys(entries).filter(
    (path) => !path.endsWith("/")
  );

  const relativePaths = makeRelativePathMap(archivePaths);
  const skippedByReason = Object.create(null);
  const warnings = [];
  const configFiles = [];
  const candidates = [];

  const skip = (reason) => {
    skippedByReason[reason] =
      (skippedByReason[reason] ?? 0) + 1;
  };

  for (let index = 0; index < archivePaths.length; index += 1) {
    throwIfAborted(signal);

    const originalPath = archivePaths[index];
    const path = relativePaths.get(originalPath);
    const bytes = entries[originalPath];

    if (
      !path ||
      !(bytes instanceof Uint8Array)
    ) {
      skip("invalid-entry");
      continue;
    }

    // Config files are not parser inputs. Preserve their original content
    // separately so GraphBuilder can use them for import alias resolution.
    if (isPathConfigFile(path)) {
      if (bytes.byteLength > MAX_PATH_CONFIG_BYTES) {
        skip("config-too-large");

        warnings.push(
          `${path} exceeded the 100 KB path-configuration limit and was ignored.`
        );

        continue;
      }

      if (containsBinaryMarker(bytes)) {
        skip("binary-config");

        warnings.push(
          `${path} contains binary data and could not be used for alias resolution.`
        );

        continue;
      }

      configFiles.push({
        path,
        content: strFromU8(bytes)
      });

      continue;
    }

    const reason = getSourceSkipReason(path, bytes.byteLength, {
      maxFileBytes
    });

    if (reason) {
      skip(reason);
      continue;
    }

    if (containsBinaryMarker(bytes)) {
      skip("binary-content");
      continue;
    }

    candidates.push({
      path,
      bytes,
      size: bytes.byteLength
    });
  }

  const capApplied = candidates.length > maxFiles;
  const selected = candidates.slice(0, maxFiles);

  if (capApplied) {
    skip("file-cap");
  }

  const files = [];

  for (let index = 0; index < selected.length; index += 1) {
    throwIfAborted(signal);

    const candidate = selected[index];

    try {
      const sha = await computeGitBlobSha(candidate.bytes);

      files.push({
        path: candidate.path,
        sha,
        size: candidate.size,
        content: strFromU8(candidate.bytes),
        source: "zip"
      });
    } catch (error) {
      skip("hash-failure");

      console.error(
        `Could not prepare ${candidate.path}.`,
        error
      );
    }

    reportProgress(onProgress, {
      phase: "zip-processing",
      done: index + 1,
      total: selected.length,
      currentFile: candidate.path
    });
  }

  configFiles.sort((a, b) => {
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

  if (configFiles.length > 32) {
    warnings.push(
      "More than 32 path configuration files were found. Only the first 32 were retained."
    );

    configFiles.length = 32;
  }

  return {
    files,
    configFiles,
    warnings,
    candidateCount: candidates.length,
    skippedCount: Object.values(skippedByReason).reduce(
      (sum, count) => sum + count,
      0
    ),
    skippedByReason,
    capApplied,
    totalEntries: stats.entryCount,
    expandedBytes: stats.expandedBytes
  };
}