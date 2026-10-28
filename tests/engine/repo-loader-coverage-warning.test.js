import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { strToU8, zipSync } from "fflate";
import RepoLoader from "../../src/engine/RepoLoader.js";
import FetchQueue from "../../src/engine/FetchQueue.js";

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function responseText(data, status = 200) {
  return new Response(data, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function makeCacheStore() {
  return {
    getMany: async () => new Map(),
    rememberRepo: async () => {},
    getStats: () => ({ hits: 0, misses: 1, hitRate: 0 })
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("repository filtering coverage warnings", () => {
  it("reports omitted GitHub paths by reason with accurate singular labels", async () => {
    const source = "export const answer = 42;";
    const tree = [
      {
        path: "src/index.js",
        mode: "100644",
        type: "blob",
        sha: "a".repeat(40),
        size: new TextEncoder().encode(source).byteLength
      },
      {
        path: "README.md",
        mode: "100644",
        type: "blob",
        sha: "b".repeat(40),
        size: 20
      },
      {
        path: "src/linked.js",
        mode: "120000",
        type: "blob",
        sha: "c".repeat(40),
        size: 20
      }
    ];

    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);

      if (url === "https://api.github.com/repos/example/demo") {
        return responseJson({
          private: false,
          default_branch: "main"
        });
      }

      if (url.includes("/repos/example/demo/git/trees/main?recursive=1")) {
        return responseJson({
          sha: "d".repeat(40),
          tree,
          truncated: false
        });
      }

      if (url.endsWith("/example/demo/main/src/index.js")) {
        return responseText(source);
      }

      return responseJson({ message: `Unexpected URL: ${url}` }, 404);
    }));

    const loader = new RepoLoader({
      cacheStore: makeCacheStore(),
      fetchQueue: new FetchQueue({ concurrency: 2, maxRetries: 0 })
    });

    const loaded = await loader.loadFromGitHub(
      "https://github.com/example/demo"
    );
    const warning = loaded.warnings.find((item) =>
      item.startsWith("Source-file filtering excluded")
    );

    expect(loaded.files).toHaveLength(1);
    expect(warning).toContain("excluded 2 paths");
    expect(warning).toContain("1 symbolic link not followed");
    expect(warning).toContain("1 unsupported file extension");
    expect(warning).toContain("Path configuration files can still be loaded separately");
  });

  it("explains ZIP filtering counts without presenting them as all failed parses", async () => {
    const bytes = zipSync({
      "demo-main/package.json": strToU8('{"name":"demo"}'),
      "demo-main/README.md": strToU8("demo"),
      "demo-main/src/index.js": strToU8("export const answer = 42;")
    });
    const archive = Object.assign(
      new Blob([bytes], { type: "application/zip" }),
      { name: "demo.zip" }
    );

    const loader = new RepoLoader({ cacheStore: makeCacheStore() });
    const loaded = await loader.loadFromZip(archive);
    const warning = loaded.warnings.find((item) =>
      item.startsWith("ZIP filtering skipped")
    );

    expect(loaded.files).toHaveLength(1);
    expect(warning).toContain("skipped 2 items");
    expect(warning).toContain("2 unsupported file extensions");
    expect(warning).toContain("Path configuration files can still be loaded separately");
  });
});
