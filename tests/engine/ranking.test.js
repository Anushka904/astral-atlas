import { describe, expect, it } from "vitest";

import DependencyGraph from "../../src/engine/DependencyGraph.js";

import {
  default as BlastRadiusAnalyzer,
  scoreComplexity,
  scoreFileSize
} from "../../src/engine/BlastRadiusAnalyzer.js";

describe("starter-file ranking", () => {
  it("gives more points to a simple, reasonably sized file with low impact", () => {
    const graph = new DependencyGraph();

    graph.addFileNode({
      path: "src/simple.js",
      loc: 80,
      cyclomaticComplexity: 1,
      parseStatus: "ok"
    });

    graph.addFileNode({
      path: "src/complex.js",
      loc: 500,
      cyclomaticComplexity: 20,
      parseStatus: "ok"
    });

    graph.addFileNode({
      path: "src/broken.js",
      loc: 0,
      cyclomaticComplexity: 0,
      parseStatus: "error"
    });

    const result = new BlastRadiusAnalyzer()
      .rankStarterFiles(graph, { limit: 10 });

    expect(result[0].path).toBe("src/simple.js");
    expect(result[0].score).toBeGreaterThan(
      result[1].score
    );

    expect(result.map((item) => item.path)).not.toContain(
      "src/broken.js"
    );

    expect(result[0].breakdown).toMatchObject({
      blastRadiusScore: 100,
      complexityScore: 100,
      sizeScore: 100,
      connectivityScore: 35,
      weights: {
        blastRadius: 0.4,
        complexity: 0.3,
        size: 0.2,
        connectivity: 0.1
      }
    });

    expect(result[0].connectionCount).toBe(0);
    expect(result[0].score).toBe(93.5);
  });

  it("reports the individual scoring dimensions", () => {
    const graph = new DependencyGraph();

    graph.addFileNode({
      path: "src/start.js",
      loc: 50,
      cyclomaticComplexity: 3,
      parseStatus: "ok"
    });

    const [candidate] = new BlastRadiusAnalyzer()
      .rankStarterFiles(graph, { limit: 1 });

    expect(candidate.breakdown).toHaveProperty(
      "blastRadiusScore"
    );
    expect(candidate.breakdown).toHaveProperty(
      "complexityScore"
    );
    expect(candidate.breakdown).toHaveProperty(
      "sizeScore"
    );
    expect(candidate.explanation).toContain("Low-impact suitability");
  });

  it("uses predictable standalone size and complexity rules", () => {
    expect(scoreFileSize(0)).toBe(0);
    expect(scoreFileSize(80)).toBe(100);
    expect(scoreFileSize(41)).toBeGreaterThan(scoreFileSize(261));
    expect(scoreFileSize(500)).toBe(68);
    expect(scoreFileSize(0)).toBe(0);

    expect(scoreComplexity(1)).toBe(100);
    expect(scoreComplexity(50)).toBe(0);
    expect(scoreComplexity(100)).toBe(0);
  });

  it("does not give isolated files a perfect connectivity score", () => {
    const graph = new DependencyGraph();

    graph.addFileNode({
      path: "src/isolated.js",
      loc: 80,
      cyclomaticComplexity: 1,
      parseStatus: "ok"
    });
    graph.addFileNode({
      path: "src/connected.js",
      loc: 80,
      cyclomaticComplexity: 1,
      parseStatus: "ok"
    });
    graph.addFileNode({
      path: "src/helper.js",
      loc: 80,
      cyclomaticComplexity: 1,
      parseStatus: "ok"
    });
    graph.addImportEdge("src/connected.js", "src/helper.js", {
      specifier: "./helper.js",
      kind: "static"
    });

    const rankings = new BlastRadiusAnalyzer()
      .rankStarterFiles(graph, { limit: 10 });
    const isolated = rankings.find((item) => item.path === "src/isolated.js");
    const connected = rankings.find((item) => item.path === "src/connected.js");

    expect(isolated.breakdown.connectivityScore).toBe(35);
    expect(connected.breakdown.connectivityScore).toBeGreaterThan(35);
    expect(connected.score).toBeGreaterThan(isolated.score);
    expect(connected.dependencyCount).toBe(1);
    expect(connected.dependentCount).toBe(0);
    expect(connected.explanation).toContain("(1 resolved internal connection).");
  });

  it("respects the requested result limit", () => {
    const graph = new DependencyGraph();

    for (let index = 0; index < 5; index += 1) {
      graph.addFileNode({
        path: `src/file-${index}.js`,
        loc: 50,
        cyclomaticComplexity: 1,
        parseStatus: "ok"
      });
    }

    const result = new BlastRadiusAnalyzer()
      .rankStarterFiles(graph, { limit: 2 });

    expect(result).toHaveLength(2);
  });
});
