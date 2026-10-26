import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import AppController from "../../src/engine/AppController.js";

import {
  parseSource
} from "../../src/engine/parser/parseSource.js";

import GraphBuilder from "../../src/engine/GraphBuilder.js";
import CallResolver from "../../src/engine/CallResolver.js";
import CycleDetector from "../../src/engine/CycleDetector.js";
import BlastRadiusAnalyzer from "../../src/engine/BlastRadiusAnalyzer.js";

function makeCacheStore() {
  return {
    resetStats: vi.fn(),

    getStats: vi.fn(() => ({
      hits: 1,
      misses: 1,
      hitRate: 0.5
    }))
  };
}

function makeLoadedRepository() {
  const appSource = `
import { helper } from "./helper.js";

export function run() {
  return helper();
}
`;

  const helperSource = `
export function helper() {
  return 42;
}
`;

  return {
    repo: {
      owner: "example",
      repo: "demo",
      fullName: "example/demo",
      branch: "main",
      source: "github",
      url: "https://github.com/example/demo"
    },

    files: [
      {
        path: "src/app.js",
        sha: "a".repeat(40),
        content: appSource,
        source: "github"
      },
      {
        path: "src/helper.js",
        sha: "b".repeat(40),
        content: helperSource,
        source: "github"
      }
    ],

    configFiles: [],

    warnings: [],

    stats: {
      eligibleFiles: 2,
      downloadedFiles: 2,
      failedFiles: 0
    }
  };
}

function makeParserPool() {
  return {
    parseFiles: vi.fn(async (files, { onProgress } = {}) => {
      const results = files.map((file, index) => ({
        path: file.path,
        sha: file.sha,
        summary: parseSource(file.content, {
          path: file.path,
          sha: file.sha
        }),
        fromCache: false
      }));

      onProgress?.({
        phase: "parsing",
        done: files.length,
        total: files.length,
        currentFile: files.at(-1)?.path
      });

      return {
        results,
        stats: {
          total: files.length,
          parsed: files.length,
          cacheHits: 0,
          failed: 0,
          cacheWriteFailures: 0
        }
      };
    }),

    destroy: vi.fn()
  };
}

function makeController({
  loaded = makeLoadedRepository(),
  loadImplementation,
  onUpdate = vi.fn()
} = {}) {
  const cacheStore = makeCacheStore();
  const parserPool = makeParserPool();

  const repoLoader = {
    loadFromGitHub: loadImplementation ??
      vi.fn(async (_url, options) => {
        options.onStage?.({
          stage: "listing",
          message: "Listing test repository"
        });

        options.onProgress?.({
          stage: "downloading",
          done: loaded.files.length,
          total: loaded.files.length
        });

        return loaded;
      }),

    loadFromZip: vi.fn(async () => loaded),

    fetchFileContent: vi.fn(async (_repo, file) => file.content)
  };

  const controller = new AppController({
    onUpdate,
    dependencies: {
      cacheStore,
      repoLoader,
      parserPool,
      graphBuilder: new GraphBuilder(),
      callResolver: new CallResolver(),
      cycleDetector: new CycleDetector(),
      blastRadiusAnalyzer: new BlastRadiusAnalyzer()
    }
  });

  return {
    controller,
    cacheStore,
    repoLoader,
    parserPool,
    onUpdate
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppController", () => {
  it("runs ingestion, parsing, graph construction and analysis end to end", async () => {
    const {
      controller,
      cacheStore,
      repoLoader,
      parserPool,
      onUpdate
    } = makeController();

    try {
      const result = await controller.analyzeGitHub(
        "https://github.com/example/demo"
      );

      expect(repoLoader.loadFromGitHub).toHaveBeenCalledTimes(1);
      expect(parserPool.parseFiles).toHaveBeenCalledTimes(1);
      expect(cacheStore.resetStats).toHaveBeenCalledTimes(1);

      expect(result.repo.fullName).toBe("example/demo");
      expect(result.graph.nodes.size).toBe(2);

      expect(result.graph.edges).toHaveLength(1);

      expect(result.graph.edges[0]).toMatchObject({
        source: "src/app.js",
        target: "src/helper.js",
        kind: "import"
      });

      const helperCall = result.graph.callReferences.find(
        (reference) => reference.calleeName === "helper"
      );

      expect(helperCall).toBeDefined();
      expect(helperCall.status).toBe("resolved");

      const helperTarget = result.graph.functionNodes.get(
        helperCall.targetFunctionIds[0]
      );

      expect(helperTarget.name).toBe("helper");

      expect(result.stats.files).toBe(2);
      expect(result.stats.edges).toBe(1);
      expect(result.cycles.cycles).toHaveLength(0);
      expect(result.starterFiles.length).toBeGreaterThan(0);

      expect(result.benchmark.fetchMs).toEqual(
        expect.any(Number)
      );

      expect(result.benchmark.parseMs).toEqual(
        expect.any(Number)
      );

      expect(result.benchmark.graphMs).toEqual(
        expect.any(Number)
      );

      expect(result.benchmark.cacheHitRate).toBe(0.5);

      expect(controller.getState().phase).toBe("complete");
      expect(controller.getState().isRunning).toBe(false);

      expect(
        onUpdate.mock.calls.some(
          ([state]) => state.stage === "parsing"
        )
      ).toBe(true);
    } finally {
      controller.destroy();
    }
  });

  it("publishes a friendly error state when loading fails", async () => {
    const failure = new Error(
      "GitHub rate limit exceeded."
    );

    failure.code = "GITHUB_RATE_LIMITED";

    const loadImplementation = vi.fn(
      async () => {
        throw failure;
      }
    );

    const { controller } = makeController({
      loadImplementation
    });

    try {
      await expect(
        controller.analyzeGitHub(
          "https://github.com/example/demo"
        )
      ).rejects.toThrow("GitHub rate limit exceeded.");

      expect(controller.getState().phase).toBe("error");
      expect(controller.getState().isRunning).toBe(false);

      expect(controller.getState().error).toMatchObject({
        message: "GitHub rate limit exceeded.",
        code: "GITHUB_RATE_LIMITED"
      });
    } finally {
      controller.destroy();
    }
  });

  it("cancels an active repository load", async () => {
    const loadImplementation = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(
              signal.reason ??
                new DOMException("Cancelled.", "AbortError")
            ),
            { once: true }
          );
        })
    );

    const { controller } = makeController({
      loadImplementation
    });

    try {
      const operation = controller.analyzeGitHub(
        "https://github.com/example/demo"
      );

      controller.cancel();

      await expect(operation).rejects.toHaveProperty(
        "name",
        "AbortError"
      );

      expect(controller.getState().phase).toBe("cancelled");
      expect(controller.getState().isRunning).toBe(false);
    } finally {
      controller.destroy();
    }
  });
});