import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { zipSync, strToU8 } from "fflate";

import RepoLoader from "../../src/engine/RepoLoader.js";
import FetchQueue from "../../src/engine/FetchQueue.js";
import GraphBuilder from "../../src/engine/GraphBuilder.js";
import CallResolver from "../../src/engine/CallResolver.js";
import { parseSource } from "../../src/engine/parser/parseSource.js";

const pathConfigText = JSON.stringify({
  compilerOptions: {
    baseUrl: ".",
    paths: {
      "@/*": ["src/*"]
    }
  }
});

const appSource = `
import { helper } from "@/utils/helper";

export function run() {
  return helper();
}
`;

const helperSource = `
export function helper() {
  return 42;
}
`;

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function responseText(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function makeCacheStore() {
  return {
    getMany: async () => new Map(),
    rememberRepo: async () => {},
    getStats: () => ({
      hits: 0,
      misses: 0,
      hitRate: 0
    })
  };
}

function parseLoadedFiles(loaded) {
  return loaded.files.map((file) => ({
    path: file.path,
    sha: file.sha,
    summary: parseSource(file.content, {
      path: file.path,
      sha: file.sha
    })
  }));
}

function assertAliasAndCallResolved(loaded) {
  expect(loaded.configFiles).toHaveLength(1);
  expect(loaded.configFiles[0].path).toBe("tsconfig.json");

  const graph = new GraphBuilder().build(
    parseLoadedFiles(loaded),
    {
      configFiles: loaded.configFiles,
      repoName: loaded.repo.fullName,
      sourceKind: loaded.repo.source
    }
  );

  // The configured @/* alias must resolve to a repository file.
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0].source).toBe("src/App.ts");
  expect(graph.edges[0].target).toBe("src/utils/helper.ts");

  // The same graph then resolves the imported function call.
  new CallResolver().resolve(graph);

  const call = graph.callReferences.find(
    (item) => item.calleeName === "helper"
  );

  expect(call).toBeDefined();
  expect(call.status).toBe("resolved");

  const target = graph.functionNodes.get(
    call.targetFunctionIds[0]
  );

  expect(target.name).toBe("helper");

  return graph;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("path configuration integration", () => {
  it("loads GitHub path configuration and resolves aliases end to end", async () => {
    const tree = [
      {
        path: "src/App.ts",
        mode: "100644",
        type: "blob",
        sha: "a".repeat(40),
        size: new TextEncoder().encode(appSource).byteLength
      },
      {
        path: "src/utils/helper.ts",
        mode: "100644",
        type: "blob",
        sha: "b".repeat(40),
        size: new TextEncoder().encode(helperSource).byteLength
      },
      {
        path: "tsconfig.json",
        mode: "100644",
        type: "blob",
        sha: "c".repeat(40),
        size: new TextEncoder().encode(pathConfigText).byteLength
      }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);

        if (
          url ===
          "https://api.github.com/repos/example/demo"
        ) {
          return responseJson({
            private: false,
            default_branch: "main"
          });
        }

        if (
          url.includes(
            "/repos/example/demo/git/trees/main?recursive=1"
          )
        ) {
          return responseJson({
            sha: "d".repeat(40),
            tree,
            truncated: false
          });
        }

        if (
          url.endsWith("/example/demo/main/tsconfig.json")
        ) {
          return responseText(pathConfigText);
        }

        if (
          url.endsWith("/example/demo/main/src/App.ts")
        ) {
          return responseText(appSource);
        }

        if (
          url.endsWith(
            "/example/demo/main/src/utils/helper.ts"
          )
        ) {
          return responseText(helperSource);
        }

        return responseJson(
          { message: `Unexpected test URL: ${url}` },
          404
        );
      })
    );

    const loader = new RepoLoader({
      cacheStore: makeCacheStore(),
      fetchQueue: new FetchQueue({
        concurrency: 2,
        maxRetries: 0
      })
    });

    const loaded = await loader.loadFromGitHub(
      "https://github.com/example/demo"
    );

    expect(loaded.repo.branch).toBe("main");
    expect(loaded.configFiles).toHaveLength(1);

    assertAliasAndCallResolved(loaded);
  });

  it("extracts path configuration from ZIP and resolves aliases end to end", async () => {
    const bytes = zipSync({
      "demo-main/tsconfig.json": strToU8(pathConfigText),
      "demo-main/src/App.ts": strToU8(appSource),
      "demo-main/src/utils/helper.ts": strToU8(helperSource)
    });

    // Blob + name is sufficient for readZipArchive and works in Node test
    // environments without relying on a browser file picker.
    const archive = Object.assign(
      new Blob([bytes], {
        type: "application/zip"
      }),
      {
        name: "demo.zip"
      }
    );

    const loader = new RepoLoader({
      cacheStore: makeCacheStore()
    });

    const loaded = await loader.loadFromZip(archive);

    expect(loaded.repo.source).toBe("zip");
    expect(loaded.configFiles).toHaveLength(1);
    expect(loaded.configFiles[0].path).toBe("tsconfig.json");

    assertAliasAndCallResolved(loaded);
  });

  it("still classifies bare package imports as external without alias configuration", () => {
    const summary = parseSource(
      'import React from "react"; export function run() { return React; }',
      { path: "src/App.js" }
    );

    const graph = new GraphBuilder().build([
      {
        path: summary.path,
        summary
      }
    ]);

    expect(graph.externalDependencyCount).toBe(1);
    expect(graph.nodes.has("react")).toBe(false);
  });
});