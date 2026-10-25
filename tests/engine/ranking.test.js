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
      weights: {
        blastRadius: 0.45,
        complexity: 0.35,
        size: 0.2
      }
    });
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
    expect(candidate.explanation).toContain("Impact");
  });

  it("uses predictable standalone size and complexity rules", () => {
    expect(scoreFileSize(0)).toBe(0);
    expect(scoreFileSize(80)).toBe(100);
    expect(scoreFileSize(500)).toBe(90);

    expect(scoreComplexity(1)).toBe(100);
    expect(scoreComplexity(50)).toBe(0);
    expect(scoreComplexity(100)).toBe(0);
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