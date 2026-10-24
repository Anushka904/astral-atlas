/**
 * IndexedDB cache for AST parse summaries and recent repositories.
 *
 * WHY:
 * - IndexedDB is asynchronous and suitable for structured browser data.
 * - Git blob SHA identifies the exact source content.
 * - parserVersion prevents stale analysis from being reused.
 * - Source code itself is not persisted by this store.
 */

import { openDB } from "idb";

export const PARSER_VERSION = "1.0.0";

const DATABASE_NAME = "astral-atlas-cache";
const DATABASE_VERSION = 1;
const PARSE_STORE = "parseResults";
const RECENT_STORE = "recentRepos";
const MAX_RECENT_REPOS = 12;

export default class CacheStore {
  /**
   * @param {{parserVersion?:string}} [options]
   */
  constructor({
    parserVersion = PARSER_VERSION
  } = {}) {
    this.parserVersion = parserVersion;

    this.dbPromise = null;
    this.db = null;

    this.stats = {
      hits: 0,
      misses: 0
    };
  }

  /**
   * Open the database lazily.
   *
   * Reuse the same opening promise so multiple callers don't unnecessarily
   * open separate connections to the same database.
   *
   * @returns {Promise<IDBPDatabase>}
   */
  async open() {
    if (!this.dbPromise) {
      const openingPromise = openDB(
        DATABASE_NAME,
        DATABASE_VERSION,
        {
          upgrade(db) {
            if (!db.objectStoreNames.contains(PARSE_STORE)) {
              db.createObjectStore(PARSE_STORE, {
                keyPath: "blobSha"
              });
            }

            if (!db.objectStoreNames.contains(RECENT_STORE)) {
              db.createObjectStore(RECENT_STORE, {
                keyPath: "key"
              });
            }
          },

          blocked() {
            console.warn(
              "Astral Atlas cache upgrade is waiting for another open tab. Close other Astral Atlas tabs if the upgrade does not proceed."
            );
          }
        }
      )
        .then((db) => {
          this.db = db;

          // Reset our reference if the browser terminates the connection.
          db.addEventListener("close", () => {
            if (this.db === db) {
              this.db = null;
              this.dbPromise = null;
            }
          });

          // WHY: Closing this connection allows a newer database version
          // to be installed by another tab or application instance.
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
          // A rejected opening promise must not permanently poison the cache.
          this.dbPromise = null;
          this.db = null;

          throw error;
        });

      this.dbPromise = openingPromise;
    }

    return this.dbPromise;
  }

  /**
   * Check whether a valid parse result exists.
   *
   * @param {string} blobSha
   * @returns {Promise<boolean>}
   */
  async has(blobSha) {
    return (await this.get(blobSha)) !== null;
  }

  /**
   * Retrieve a cached summary for one Git blob SHA.
   *
   * WHY: Awaiting tx.done ensures the readonly transaction has completed
   * before we report the cache lookup as finished.
   *
   * @param {string} blobSha
   * @returns {Promise<object|null>}
   */
  async get(blobSha) {
    const db = await this.open();

    const tx = db.transaction(
      PARSE_STORE,
      "readonly"
    );

    const recordPromise = tx.store.get(blobSha);

    const [record] = await Promise.all([
      recordPromise,
      tx.done
    ]);

    if (
      !record ||
      record.parserVersion !== this.parserVersion
    ) {
      this.stats.misses += 1;

      return null;
    }

    this.stats.hits += 1;

    return record.summary ?? null;
  }

  /**
   * Retrieve many summaries through one read transaction.
   *
   * Duplicate SHA values are looked up only once.
   *
   * @param {string[]} blobShas
   * @returns {Promise<Map<string,object>>}
   */
  async getMany(blobShas) {
    const uniqueShas = [...new Set(blobShas)];
    const results = new Map();

    if (uniqueShas.length === 0) {
      return results;
    }

    const db = await this.open();

    const tx = db.transaction(
      PARSE_STORE,
      "readonly"
    );

    // Queue all reads while the transaction is active.
    const recordPromises = uniqueShas.map(
      (sha) => tx.store.get(sha)
    );

    const [records] = await Promise.all([
      Promise.all(recordPromises),
      tx.done
    ]);

    for (let index = 0; index < uniqueShas.length; index += 1) {
      const sha = uniqueShas[index];
      const record = records[index];

      if (
        record &&
        record.parserVersion === this.parserVersion &&
        record.summary &&
        typeof record.summary === "object"
      ) {
        results.set(sha, record.summary);
        this.stats.hits += 1;
      } else {
        this.stats.misses += 1;
      }
    }

    return results;
  }

  /**
   * Store a parsed summary under its Git blob SHA.
   *
   * The parser version is stored with each record so a later extraction
   * algorithm change can invalidate older summaries.
   *
   * @param {string} blobSha
   * @param {object} summary
   * @returns {Promise<void>}
   */
  async put(blobSha, summary) {
    if (
      typeof blobSha !== "string" ||
      !/^[a-f0-9]{40}$/i.test(blobSha)
    ) {
      throw new TypeError(
        "A valid 40-character Git blob SHA is required."
      );
    }

    if (
      !summary ||
      typeof summary !== "object" ||
      Array.isArray(summary)
    ) {
      throw new TypeError(
        "CacheStore only accepts a structured parse summary."
      );
    }

    const db = await this.open();

    await db.put(PARSE_STORE, {
      blobSha: blobSha.toLowerCase(),
      parserVersion: this.parserVersion,
      summary,
      cachedAt: Date.now()
    });
  }

  /**
   * Delete one cached parse summary.
   *
   * @param {string} blobSha
   * @returns {Promise<void>}
   */
  async delete(blobSha) {
    const db = await this.open();

    await db.delete(
      PARSE_STORE,
      blobSha.toLowerCase()
    );
  }

  /**
   * Remove all cached parse summaries without deleting repository history.
   *
   * @returns {Promise<void>}
   */
  async clearParseResults() {
    const db = await this.open();

    await db.clear(PARSE_STORE);
  }

  /**
   * Store a repository in recent history.
   *
   * A repository is identified by its normalized, case-insensitive name.
   *
   * @param {{
   *   owner?:string|null,
   *   repo?:string|null,
   *   fullName?:string,
   *   url?:string|null,
   *   branch?:string|null
   * }} repoInfo
   * @returns {Promise<void>}
   */
  async rememberRepo(repoInfo) {
    if (!repoInfo || typeof repoInfo !== "object") {
      throw new TypeError(
        "Repository information must be an object."
      );
    }

    const fullName =
      repoInfo.fullName ||
      [
        repoInfo.owner,
        repoInfo.repo
      ].filter(Boolean).join("/");

    if (
      typeof fullName !== "string" ||
      !fullName.trim()
    ) {
      throw new TypeError(
        "Repository information must include a repository name."
      );
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

    const all = await db.getAll(RECENT_STORE);

    all.sort((a, b) => b.openedAt - a.openedAt);

    // Use a separate readwrite transaction for deletion. The previous
    // getAll() call has completed before this transaction is created.
    const tx = db.transaction(
      RECENT_STORE,
      "readwrite"
    );

    for (const stale of all.slice(MAX_RECENT_REPOS)) {
      await tx.store.delete(stale.key);
    }

    await tx.done;
  }

  /**
   * Retrieve recent repositories, newest first.
   *
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async listRecentRepos(limit = MAX_RECENT_REPOS) {
    if (
      !Number.isFinite(limit) ||
      limit < 0
    ) {
      throw new RangeError(
        "The recent repository limit must be a non-negative number."
      );
    }

    const db = await this.open();
    const records = await db.getAll(RECENT_STORE);

    return records
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, Math.floor(limit));
  }

  /**
   * Return the current cache statistics.
   *
   * The hit rate is a fraction from 0 to 1, not a percentage.
   *
   * @returns {{hits:number,misses:number,hitRate:number}}
   */
  getStats() {
    const {
      hits,
      misses
    } = this.stats;

    const total = hits + misses;

    return {
      hits,
      misses,
      hitRate: total === 0 ? 0 : hits / total
    };
  }

  /**
   * Reset counters without clearing the cached data.
   *
   * @returns {void}
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0
    };
  }

  /**
   * Close the current database connection.
   *
   * The cached promise is cleared so the next operation can reopen it.
   * This also makes the store easier to clean up in tests.
   *
   * @returns {void}
   */
  close() {
    this.db?.close();

    this.db = null;
    this.dbPromise = null;
  }
}