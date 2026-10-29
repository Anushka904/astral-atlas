/**
 * IndexedDB cache for AST parse summaries and recent repositories.
 *
 * A parse summary depends on both content and the file extension (the Babel
 * syntax plugins are selected from that extension). Summaries also contain a
 * path field, so callers must rebind cached data to the path currently being
 * analysed instead of reusing the original path.
 */

import { openDB } from "idb";

// Version 3 adds complete CommonJS binding/export metadata to parser summaries.
export const PARSER_VERSION = "3.0.0";

const DATABASE_NAME = "astral-atlas-cache";
const DATABASE_VERSION = 1;
const PARSE_STORE = "parseResults";
const RECENT_STORE = "recentRepos";
const MAX_RECENT_REPOS = 12;

function normalizeSha(blobSha) {
  if (typeof blobSha !== "string" || !/^[a-f0-9]{40}$/i.test(blobSha)) {
    throw new TypeError("A valid 40-character Git blob SHA is required.");
  }

  return blobSha.toLowerCase();
}

/**
 * Return the lower-case extension which controls Babel's syntax plugins.
 * Files with no extension use the empty extension string.
 *
 * @param {string|null|undefined} path
 * @returns {string}
 */
export function getParseFileExtension(path) {
  if (typeof path !== "string" || !path) {
    return "";
  }

  const fileName = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = fileName.match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Compute the cache key for a parse result. The IndexedDB store retains its
 * existing `blobSha` keyPath for backward compatibility; the value now holds
 * the SHA plus the syntax-relevant extension.
 *
 * @param {string} blobSha
 * @param {string} path
 * @returns {string}
 */
export function getParseCacheKey(blobSha, path) {
  return `${normalizeSha(blobSha)}::${getParseFileExtension(path) || "<none>"}`;
}

/**
 * Bind a content-derived cache summary to the file being analysed now.
 * Function and binding IDs remain file-local and are qualified by GraphBuilder.
 *
 * @param {object|null|undefined} summary
 * @param {{path:string,sha?:string|null}} file
 * @returns {object|null}
 */
export function rebaseCachedSummary(summary, file) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return null;
  }

  return {
    ...summary,
    path: file.path,
    sha: file.sha ?? summary.sha ?? null
  };
}

function isCompatibleRecord(record, parserVersion) {
  return Boolean(
    record &&
    record.parserVersion === parserVersion &&
    record.summary &&
    typeof record.summary === "object" &&
    !Array.isArray(record.summary)
  );
}

function legacyRecordMatchesPath(record, path) {
  if (!path) {
    return true;
  }

  return getParseFileExtension(record?.summary?.path) ===
    getParseFileExtension(path);
}

function normalizeRequest(request) {
  if (typeof request === "string") {
    return {
      sha: normalizeSha(request),
      path: null,
      key: normalizeSha(request),
      legacyOnly: true
    };
  }

  if (!request || typeof request !== "object") {
    throw new TypeError("Cache lookups require a blob SHA and file path.");
  }

  const sha = normalizeSha(request.sha ?? request.blobSha);
  if (typeof request.path !== "string" || !request.path) {
    throw new TypeError("Cache lookups require a non-empty file path.");
  }

  return {
    sha,
    path: request.path,
    key: getParseCacheKey(sha, request.path),
    legacyOnly: false
  };
}

export default class CacheStore {
  /**
   * @param {{parserVersion?:string}} [options]
   */
  constructor({ parserVersion = PARSER_VERSION } = {}) {
    this.parserVersion = parserVersion;
    this.dbPromise = null;
    this.db = null;
    this.stats = { hits: 0, misses: 0 };
  }

  /** @returns {Promise<IDBPDatabase>} */
  async open() {
    if (!this.dbPromise) {
      const openingPromise = openDB(
        DATABASE_NAME,
        DATABASE_VERSION,
        {
          upgrade(db) {
            if (!db.objectStoreNames.contains(PARSE_STORE)) {
              db.createObjectStore(PARSE_STORE, { keyPath: "blobSha" });
            }
            if (!db.objectStoreNames.contains(RECENT_STORE)) {
              db.createObjectStore(RECENT_STORE, { keyPath: "key" });
            }
          },
          blocked() {
            console.warn("Astral Atlas cache upgrade is waiting for another open tab.");
          }
        }
      )
        .then((db) => {
          this.db = db;
          db.addEventListener("close", () => {
            if (this.db === db) {
              this.db = null;
              this.dbPromise = null;
            }
          });
          db.addEventListener("versionchange", () => {
            db.close();
            if (this.db === db) {
              this.db = null;
              this.dbPromise = null;
            }
          });
          return db;
        })
        .catch((error) => {
          this.dbPromise = null;
          this.db = null;
          throw error;
        });

      this.dbPromise = openingPromise;
    }

    return this.dbPromise;
  }

  /** @param {string} blobSha @param {string} [path] @returns {Promise<boolean>} */
  async has(blobSha, path = null) {
    return (await this.get(blobSha, path)) !== null;
  }

  /**
   * Retrieve a compatible cached summary. Supplying a path enables the
   * extension-aware key and prevents using an old cache record parsed under a
   * different syntax mode.
   *
   * @param {string} blobSha
   * @param {string|null} [path]
   * @returns {Promise<object|null>}
   */
  async get(blobSha, path = null) {
    const sha = normalizeSha(blobSha);
    const db = await this.open();

    // Preserve the historical SHA-only API. It is not used in the hot
    // repository-loading path; that path supplies descriptors to getMany().
    // A pathless query may match more than one extension variant, so return
    // the newest compatible record for this content SHA.
    if (!path) {
      const records = await db.getAll(PARSE_STORE);
      const record = records
        .filter((candidate) =>
          (candidate.contentSha === sha || candidate.blobSha === sha) &&
          isCompatibleRecord(candidate, this.parserVersion)
        )
        .sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0))[0];

      if (!record) {
        this.stats.misses += 1;
        return null;
      }

      this.stats.hits += 1;
      return record.summary;
    }

    const tx = db.transaction(PARSE_STORE, "readonly");
    const exactPromise = tx.store.get(getParseCacheKey(sha, path));
    const legacyPromise = tx.store.get(sha);

    const [exactRecord, legacyRecord] = await Promise.all([
      exactPromise,
      legacyPromise,
      tx.done
    ]).then(([exact, legacy]) => [exact, legacy]);

    let record = null;
    if (isCompatibleRecord(exactRecord, this.parserVersion)) {
      record = exactRecord;
    } else if (
      isCompatibleRecord(legacyRecord, this.parserVersion) &&
      legacyRecordMatchesPath(legacyRecord, path)
    ) {
      record = legacyRecord;
    }

    if (!record) {
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    return path
      ? rebaseCachedSummary(record.summary, { path, sha })
      : record.summary;
  }

  /**
   * Retrieve many summaries in one read transaction. Path descriptors are
   * recommended: `[{ sha, path }]`. The returned Map is keyed by the composite
   * key from getParseCacheKey(). String SHA inputs remain supported for callers
   * that intentionally use the legacy SHA-only lookup.
   *
   * @param {Array<string|{sha:string,path:string}>} requests
   * @returns {Promise<Map<string,object>>}
   */
  async getMany(requests) {
    if (!Array.isArray(requests)) {
      throw new TypeError("CacheStore.getMany expects an array.");
    }

    const normalized = new Map();
    for (const request of requests) {
      const item = normalizeRequest(request);
      if (!normalized.has(item.key)) {
        normalized.set(item.key, item);
      }
    }

    const results = new Map();
    if (normalized.size === 0) {
      return results;
    }

    const db = await this.open();
    const items = [...normalized.values()];
    const shaOnlyItems = items.filter((item) => item.legacyOnly);
    const pathAwareItems = items.filter((item) => !item.legacyOnly);

    // Preserve the historical SHA-only form for callers that don't supply a
    // path. Composite extension keys mean the newest compatible variant must
    // be selected from the store rather than fetched by the raw SHA key.
    if (shaOnlyItems.length > 0) {
      const records = await db.getAll(PARSE_STORE);
      for (const item of shaOnlyItems) {
        const record = records
          .filter((candidate) =>
            (candidate.contentSha === item.sha || candidate.blobSha === item.sha) &&
            isCompatibleRecord(candidate, this.parserVersion)
          )
          .sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0))[0];

        if (record) {
          this.stats.hits += 1;
          results.set(item.key, record.summary);
        } else {
          this.stats.misses += 1;
        }
      }
    }

    if (pathAwareItems.length === 0) {
      return results;
    }

    const tx = db.transaction(PARSE_STORE, "readonly");
    const lookups = pathAwareItems.map(async (item) => {
      const exactPromise = tx.store.get(item.key);
      const legacyPromise = item.key === item.sha
        ? Promise.resolve(null)
        : tx.store.get(item.sha);
      const [exact, legacy] = await Promise.all([exactPromise, legacyPromise]);

      let record = null;
      if (isCompatibleRecord(exact, this.parserVersion)) {
        record = exact;
      } else if (
        isCompatibleRecord(legacy, this.parserVersion) &&
        legacyRecordMatchesPath(legacy, item.path)
      ) {
        record = legacy;
      }

      if (!record) {
        this.stats.misses += 1;
        return;
      }

      this.stats.hits += 1;
      results.set(item.key, record.summary);
    });

    await Promise.all([...lookups, tx.done]);
    return results;
  }

  /**
   * Store a parse summary. Content SHA plus extension is used as the primary
   * key, while the true SHA remains available as `contentSha` for diagnostics.
   *
   * @param {string} blobSha
   * @param {object} summary
   * @returns {Promise<void>}
   */
  async put(blobSha, summary) {
    const sha = normalizeSha(blobSha);
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      throw new TypeError("CacheStore only accepts a structured parse summary.");
    }

    const path = typeof summary.path === "string" ? summary.path : "";
    const cacheKey = getParseCacheKey(sha, path);
    const db = await this.open();

    await db.put(PARSE_STORE, {
      // The existing object store uses `blobSha` as keyPath; it now contains
      // the composite cache key. `contentSha` retains the actual Git blob SHA.
      blobSha: cacheKey,
      contentSha: sha,
      extension: getParseFileExtension(path),
      parserVersion: this.parserVersion,
      summary: { ...summary, path, sha },
      cachedAt: Date.now()
    });
  }

  /** @param {string} blobSha @param {string|null} [path] @returns {Promise<void>} */
  async delete(blobSha, path = null) {
    const sha = normalizeSha(blobSha);
    const db = await this.open();

    if (path) {
      await db.delete(PARSE_STORE, getParseCacheKey(sha, path));

      // Remove a compatible pre-composite record for this syntax extension
      // as well, if one is still present from an interrupted migration.
      const legacyRecord = await db.get(PARSE_STORE, sha);
      if (legacyRecordMatchesPath(legacyRecord, path)) {
        await db.delete(PARSE_STORE, sha);
      }
      return;
    }

    // Preserve the old method's SHA-oriented semantics by removing all entries
    // for this content SHA, including composite extension keys.
    const records = await db.getAll(PARSE_STORE);
    const tx = db.transaction(PARSE_STORE, "readwrite");
    for (const record of records) {
      if (
        record.blobSha === sha ||
        record.contentSha === sha ||
        record.blobSha?.startsWith(`${sha}::`)
      ) {
        await tx.store.delete(record.blobSha);
      }
    }
    await tx.done;
  }

  /** @returns {Promise<void>} */
  async clearParseResults() {
    const db = await this.open();
    await db.clear(PARSE_STORE);
  }

  /** @param {object} repoInfo @returns {Promise<void>} */
  async rememberRepo(repoInfo) {
    if (!repoInfo || typeof repoInfo !== "object") {
      throw new TypeError("Repository information must be an object.");
    }

    const fullName = repoInfo.fullName ||
      [repoInfo.owner, repoInfo.repo].filter(Boolean).join("/");
    if (typeof fullName !== "string" || !fullName.trim()) {
      throw new TypeError("Repository information must include a repository name.");
    }

    const db = await this.open();
    const key = fullName.trim().toLowerCase();
    await db.put(RECENT_STORE, {
      key,
      fullName: fullName.trim(),
      owner: repoInfo.owner ?? null,
      repo: repoInfo.repo ?? fullName.trim(),
      branch: repoInfo.branch ?? null,
      url: repoInfo.url ?? null,
      openedAt: Date.now()
    });

    const recent = await db.getAll(RECENT_STORE);
    recent.sort((a, b) => b.openedAt - a.openedAt);
    const tx = db.transaction(RECENT_STORE, "readwrite");
    for (const stale of recent.slice(MAX_RECENT_REPOS)) {
      await tx.store.delete(stale.key);
    }
    await tx.done;
  }

  /** @param {number} [limit] @returns {Promise<object[]>} */
  async listRecentRepos(limit = MAX_RECENT_REPOS) {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new RangeError("The recent repository limit must be non-negative.");
    }

    const db = await this.open();
    const recent = await db.getAll(RECENT_STORE);
    return recent
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, Math.floor(limit));
  }

  /** @returns {{hits:number,misses:number,hitRate:number}} */
  getStats() {
    const { hits, misses } = this.stats;
    const total = hits + misses;
    return { hits, misses, hitRate: total === 0 ? 0 : hits / total };
  }

  /** @returns {void} */
  resetStats() {
    this.stats = { hits: 0, misses: 0 };
  }

  /** @returns {void} */
  close() {
    this.db?.close();
    this.db = null;
    this.dbPromise = null;
  }
}
