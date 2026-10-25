/**
 * IndexedDB cache for AST parse summaries and recent repositories.
 *
 * Parser version 2 invalidates summaries created before scope-aware call
 * metadata and exportBindings were added to the parser output.
 */

import { openDB } from "idb";

export const PARSER_VERSION = "2.0.0";

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
   * Open the database lazily and reuse its promise.
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
              "Astral Atlas cache upgrade is waiting for another open tab."
            );
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

  /**
   * Check whether a compatible parse summary exists.
   *
   * @param {string} blobSha
   * @returns {Promise<boolean>}
   */
  async has(blobSha) {
    return (await this.get(blobSha)) !== null;
  }

  /**
   * Retrieve one compatible cached summary.
   *
   * @param {string} blobSha
   * @returns {Promise<object|null>}
   */
  async get(blobSha) {
    const db = await this.open();
    const tx = db.transaction(PARSE_STORE, "readonly");
    const recordPromise = tx.store.get(blobSha);

    const [record] = await Promise.all([
      recordPromise,
      tx.done
    ]);

    if (
      !record ||
      record.parserVersion !== this.parserVersion ||
      !record.summary ||
      typeof record.summary !== "object"
    ) {
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    return record.summary;
  }

  /**
   * Retrieve many summaries through one read transaction.
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
    const tx = db.transaction(PARSE_STORE, "readonly");

    const recordPromises = uniqueShas.map(
      (sha) => tx.store.get(sha)
    );

    const [records] = await Promise.all([
      Promise.all(recordPromises),
      tx.done
    ]);

    for (let index = 0; index < uniqueShas.length; index += 1) {
      const record = records[index];

      if (
        record &&
        record.parserVersion === this.parserVersion &&
        record.summary &&
        typeof record.summary === "object"
      ) {
        results.set(uniqueShas[index], record.summary);
        this.stats.hits += 1;
      } else {
        this.stats.misses += 1;
      }
    }

    return results;
  }

  /**
   * Store a parse summary using a Git blob SHA.
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
   * Delete one parse summary.
   *
   * @param {string} blobSha
   * @returns {Promise<void>}
   */
  async delete(blobSha) {
    const db = await this.open();
    await db.delete(PARSE_STORE, blobSha.toLowerCase());
  }

  /**
   * Clear parse summaries without deleting recent repository history.
   *
   * @returns {Promise<void>}
   */
  async clearParseResults() {
    const db = await this.open();
    await db.clear(PARSE_STORE);
  }

  /**
   * Save a recently opened repository.
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
      [repoInfo.owner, repoInfo.repo]
        .filter(Boolean)
        .join("/");

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

    const recent = await db.getAll(RECENT_STORE);

    recent.sort((a, b) => b.openedAt - a.openedAt);

    const tx = db.transaction(RECENT_STORE, "readwrite");

    for (const stale of recent.slice(MAX_RECENT_REPOS)) {
      await tx.store.delete(stale.key);
    }

    await tx.done;
  }

  /**
   * List recent repositories from newest to oldest.
   *
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async listRecentRepos(limit = MAX_RECENT_REPOS) {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new RangeError(
        "The recent repository limit must be non-negative."
      );
    }

    const db = await this.open();
    const recent = await db.getAll(RECENT_STORE);

    return recent
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, Math.floor(limit));
  }

  /**
   * Return cache hit statistics.
   *
   * @returns {{hits:number,misses:number,hitRate:number}}
   */
  getStats() {
    const { hits, misses } = this.stats;
    const total = hits + misses;

    return {
      hits,
      misses,
      hitRate: total === 0 ? 0 : hits / total
    };
  }

  /**
   * Reset counters without clearing cached records.
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
   * Close the active database connection.
   *
   * @returns {void}
   */
  close() {
    this.db?.close();
    this.db = null;
    this.dbPromise = null;
  }
}