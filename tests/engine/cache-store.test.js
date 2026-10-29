import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const indexedDbState = vi.hoisted(() => ({
  db: null,
  stores: new Map(),
  keyPaths: new Map()
}));

vi.mock("idb", () => {
  function createDb() {
    const db = {
      objectStoreNames: {
        contains(name) {
          return indexedDbState.stores.has(name);
        }
      },
      createObjectStore(name, { keyPath }) {
        indexedDbState.stores.set(name, new Map());
        indexedDbState.keyPaths.set(name, keyPath);
      },
      addEventListener() {},
      close() {},
      transaction(name, _mode) {
        const storeMap = indexedDbState.stores.get(name);
        const keyPath = indexedDbState.keyPaths.get(name);
        if (!storeMap || !keyPath) {
          throw new Error(`Missing fake object store: ${name}`);
        }

        const store = {
          get(key) {
            return Promise.resolve(storeMap.get(key) ?? undefined);
          },
          put(value) {
            const key = value[keyPath];
            storeMap.set(key, structuredClone(value));
            return Promise.resolve(key);
          },
          delete(key) {
            storeMap.delete(key);
            return Promise.resolve();
          },
          clear() {
            storeMap.clear();
            return Promise.resolve();
          },
          getAll() {
            return Promise.resolve([...storeMap.values()].map((value) => structuredClone(value)));
          }
        };

        return { store, done: Promise.resolve() };
      },
      put(name, value) {
        return db.transaction(name, "readwrite").store.put(value);
      },
      get(name, key) {
        return db.transaction(name, "readonly").store.get(key);
      },
      getAll(name) {
        return db.transaction(name, "readonly").store.getAll();
      },
      delete(name, key) {
        return db.transaction(name, "readwrite").store.delete(key);
      },
      clear(name) {
        return db.transaction(name, "readwrite").store.clear();
      }
    };
    return db;
  }

  return {
    openDB: async (_name, _version, callbacks) => {
      if (!indexedDbState.db) {
        indexedDbState.db = createDb();
        callbacks?.upgrade?.(indexedDbState.db, 0, _version, null);
      }
      return indexedDbState.db;
    }
  };
});

import CacheStore, {
  getParseCacheKey,
  getParseFileExtension,
  rebaseCachedSummary
} from "../../src/engine/CacheStore.js";

const SHA = "a".repeat(40);

beforeEach(() => {
  indexedDbState.db = null;
  indexedDbState.stores.clear();
  indexedDbState.keyPaths.clear();
});

describe("CacheStore parse cache identity", () => {
  it("keys identical content separately when Babel syntax extensions differ", () => {
    expect(getParseFileExtension("src/App.TS")).toBe(".ts");
    expect(getParseCacheKey(SHA, "src/App.js")).not.toBe(
      getParseCacheKey(SHA, "src/App.ts")
    );
  });

  it("uses a content and extension cache key, then reuses the summary at a different path", async () => {
    const cache = new CacheStore();
    const sourceSummary = {
      path: "packages/one/src/index.js",
      sha: SHA,
      imports: [{ source: "./utils" }],
      functions: [{ id: "run@1:0", name: "run" }],
      parseStatus: "ok"
    };

    await cache.put(SHA, sourceSummary);

    const results = await cache.getMany([
      { sha: SHA, path: "packages/two/src/index.js" }
    ]);

    expect(results.get(getParseCacheKey(SHA, "packages/two/src/index.js")))
      .toMatchObject({ path: "packages/one/src/index.js" });
    expect(rebaseCachedSummary(
      results.get(getParseCacheKey(SHA, "packages/two/src/index.js")),
      { path: "packages/two/src/index.js", sha: SHA }
    )).toMatchObject({
      path: "packages/two/src/index.js",
      sha: SHA
    });
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 0, hitRate: 1 });
  });

  it("preserves the SHA-only get API across extension-aware keys", async () => {
    const cache = new CacheStore();
    const summary = {
      path: "src/shared.js",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    };

    await cache.put(SHA, summary);

    expect(await cache.get(SHA)).toMatchObject({
      path: "src/shared.js",
      sha: SHA
    });
    expect(await cache.has(SHA)).toBe(true);

    await cache.delete(SHA);
    expect(await cache.get(SHA)).toBeNull();
  });

  it("supports SHA-only getMany lookups after keys become extension-aware", async () => {
    const cache = new CacheStore();
    await cache.put(SHA, {
      path: "src/shared.js",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    });

    const results = await cache.getMany([SHA]);

    expect(results.get(SHA)).toMatchObject({
      path: "src/shared.js",
      sha: SHA
    });
    expect(cache.getStats()).toMatchObject({
      hits: 1,
      misses: 0,
      hitRate: 1
    });
  });

  it("removes only the matching extension variant when a path is supplied", async () => {
    const cache = new CacheStore();
    await cache.put(SHA, {
      path: "src/shared.js",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    });
    await cache.put(SHA, {
      path: "src/shared.ts",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    });

    await cache.delete(SHA, "src/shared.js");

    expect(await cache.get(SHA, "src/shared.js")).toBeNull();
    expect(await cache.get(SHA, "src/shared.ts")).toMatchObject({
      path: "src/shared.ts",
      sha: SHA
    });
  });

  it("does not reuse a JavaScript parse summary for a TypeScript path", async () => {
    const cache = new CacheStore();
    await cache.put(SHA, {
      path: "src/shared.js",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    });

    const results = await cache.getMany([
      { sha: SHA, path: "src/shared.ts" }
    ]);

    expect(results.has(getParseCacheKey(SHA, "src/shared.ts"))).toBe(false);
    expect(cache.getStats()).toMatchObject({ hits: 0, misses: 1, hitRate: 0 });
  });

  it("invalidates cached summaries when the parser version changes", async () => {
    const oldCache = new CacheStore({ parserVersion: "old-parser" });
    await oldCache.put(SHA, {
      path: "src/file.js",
      sha: SHA,
      parseStatus: "ok",
      functions: []
    });

    const newCache = new CacheStore({ parserVersion: "new-parser" });
    const results = await newCache.getMany([
      { sha: SHA, path: "src/file.js" }
    ]);

    expect(results.size).toBe(0);
    expect(newCache.getStats()).toMatchObject({ hits: 0, misses: 1, hitRate: 0 });
  });
});
