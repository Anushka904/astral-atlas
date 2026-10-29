import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import RepoLoader from "../../src/engine/RepoLoader.js";
import { computeGitBlobSha } from "../../src/engine/utils/blobSha.js";
import { getParseCacheKey } from "../../src/engine/CacheStore.js";

describe("RepoLoader cached summary rebinding", () => {
  it("rebinds identical cached content to every current path in a ZIP", async () => {
    const source = "export function shared() { return 1; }";
    const sha = await computeGitBlobSha(source);
    const cachedSummary = {
      path: "src/a.js",
      sha,
      loc: 1,
      tokenCount: 10,
      cyclomaticComplexity: 1,
      imports: [],
      exports: ["shared"],
      exportBindings: [],
      functions: [{ id: "shared@1:0", name: "shared", calls: [] }],
      parseStatus: "ok",
      parseErrors: [],
      warning: null
    };

    const getMany = vi.fn(async () => new Map([
      [getParseCacheKey(sha, "src/a.js"), cachedSummary]
    ]));
    const cacheStore = {
      getMany,
      rememberRepo: vi.fn(async () => {})
    };
    const loader = new RepoLoader({ cacheStore });
    const archiveBytes = zipSync({
      "src/a.js": strToU8(source),
      "src/b.js": strToU8(source)
    });
    const archiveFile = {
      name: "duplicate-content.zip",
      size: archiveBytes.byteLength,
      arrayBuffer: async () => archiveBytes.buffer.slice(
        archiveBytes.byteOffset,
        archiveBytes.byteOffset + archiveBytes.byteLength
      )
    };

    const loaded = await loader.loadFromZip(archiveFile);

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls[0][0]).toEqual([
      { sha, path: "src/a.js" },
      { sha, path: "src/b.js" }
    ]);
    expect(loaded.files.map((file) => file.path).sort())
      .toEqual(["src/a.js", "src/b.js"]);
    expect(loaded.files.map((file) => file.cachedSummary.path).sort())
      .toEqual(["src/a.js", "src/b.js"]);
    expect(loaded.files.every((file) => file.cachedSummary.sha === sha))
      .toBe(true);
    expect(loaded.stats.cacheHits).toBe(2);
    expect(loaded.stats.cacheMisses).toBe(0);
  });
});
