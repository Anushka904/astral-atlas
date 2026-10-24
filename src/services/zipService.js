/**
 * Local ZIP archive reader for Astral Atlas.
 *
 * WHY:
 * - ZIP ingestion should not require any network connection.
 * - Local files must use the same path filters and Git blob SHA format.
 * - Archive limits reduce the risk of exhausting browser memory.
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
 * Inspect the ZIP central directory before decompression.
 *
 * Classic ZIP central-directory sizes make it possible to reject
 * oversized archives before asking fflate to expand their contents.
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

  if (entryCount !== entriesOnDisk) {
    throw new Error(
      "The ZIP entry count is inconsistent."
    );
  }

  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `This ZIP has more than ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries.`
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

    // Read the filename to validate that the directory entry is
    // structurally present. Actual path filtering happens after unzip.
    decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + fileNameLength)
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
 * Strip a common top-level directory from a GitHub ZIP archive.
 *
 * GitHub archives normally contain a single root directory, such as
 * repository-main/. Removing it gives the graph repository-relative paths.
 *
 * @param {string[]} paths
 * @returns {Map<string,string>}
 */
function makeRelativePathMap(paths) {
  const normalizedPaths = paths.map((path) => ({
    original: path,
    normalized: normalizeRepoPath(path)
  }));

  const validPaths = normalizedPaths.filter(
    (item) => item.normalized
  );

  const firstParts = validPaths.map(
    ({ normalized }) => normalized.split("/")
  );

  const firstSegment = firstParts[0]?.[0];

  const hasSingleRoot =
    Boolean(firstSegment) &&
    firstParts.every(
      (parts) =>
        parts.length > 1 &&
        parts[0] === firstSegment
    );

  const prefix = hasSingleRoot
    ? `${firstSegment}/`
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

function reportProgress(callback, event) {
  if (typeof callback !== "function") {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    console.error(
      "ZIP progress callback failed.",
      error
    );
  }
}

/**
 * Unpack a ZIP and return eligible JavaScript/TypeScript files.
 *
 * Returned file records include source content because the files are
 * already available locally. They do not include an AST.
 *
 * @param {File} file
 * @param {{
 *   maxFileBytes?:number,
 *   maxFiles?:number,
 *   signal?:AbortSignal,
 *   onProgress?:(event:object)=>void
 * }} [options]
 * @returns {Promise<{
 *   files:Array<object>,
 *   candidateCount:number,
 *   skippedCount:number,
 *   skippedByReason:Record<string,number>,
 *   capApplied:boolean,
 *   totalEntries:number,
 *   expandedBytes:number
 * }>}
 */
export async function readZipArchive(
  file,
  {
    maxFileBytes = MAX_SOURCE_FILE_BYTES,
    maxFiles = MAX_SOURCE_FILES,
    signal,
    onProgress
  } = {}
) {
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

  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Cancelled.", "AbortError");
  }

  const archiveBuffer = await file.arrayBuffer();
  const archiveBytes = new Uint8Array(archiveBuffer);

  const stats = inspectZipDirectory(archiveBytes);

  let entries;

  try {
    entries = unzipSync(archiveBytes);
  } catch (error) {
    throw new Error(
      "The ZIP could not be extracted. It may be damaged or use an unsupported compression method.",
      { cause: error }
    );
  }

  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Cancelled.", "AbortError");
  }

  const archivePaths = Object.keys(entries).filter(
    (path) => !path.endsWith("/")
  );

  const relativePaths = makeRelativePathMap(archivePaths);
  const skippedByReason = Object.create(null);
  const candidates = [];

  const skip = (reason) => {
    skippedByReason[reason] =
      (skippedByReason[reason] ?? 0) + 1;
  };

  for (let index = 0; index < archivePaths.length; index += 1) {
    if (signal?.aborted) {
      throw signal.reason ??
        new DOMException("Cancelled.", "AbortError");
    }

    const originalPath = archivePaths[index];
    const path = relativePaths.get(originalPath);

    const bytes = entries[originalPath];

    if (!(bytes instanceof Uint8Array)) {
      skip("invalid-entry");
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
    if (signal?.aborted) {
      throw signal.reason ??
        new DOMException("Cancelled.", "AbortError");
    }

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

  return {
    files,
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