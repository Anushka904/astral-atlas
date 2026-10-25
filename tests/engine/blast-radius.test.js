import { describe, expect, it } from "vitest";

import DependencyGraph from "../../src/engine/DependencyGraph.js";
import BlastRadiusAnalyzer from "../../src/engine/BlastRadiusAnalyzer.js";

function addFile(graph, path) {
  graph.addFileNode({
    path,
    loc: 20,
    cyclomaticComplexity: 1,
    parseStatus: "ok"
  });
}

function addEdge(graph, importer, dependency) {
  graph.addImportEdge(importer, dependency, {
    specifier: `./${dependency}`,
    kind: "static"
  });
}

describe("BlastRadiusAnalyzer", () => {
  it("finds direct and indirect importers using reverse BFS", () => {
    const graph = new DependencyGraph();

    for (const path of [
      "src/service.js",
      "src/app.js",
      "src/dashboard.js",
      "src/cli.js",
      "src/orphan.js"
    ]) {
      addFile(graph, path);
    }

    addEdge(graph, "src/app.js", "src/service.js");
    addEdge(graph, "src/dashboard.js", "src/app.js");
    addEdge(graph, "src/cli.js", "src/service.js");

    const analyzer = new BlastRadiusAnalyzer();
    const result = analyzer.analyze(
      graph,
      "src/service.js"
    );

    expect(result.blastRadius).toBe(3);

    expect(
      result.impacted.map((item) => item.path)
    ).toEqual([
      "src/app.js",
      "src/cli.js",
      "src/dashboard.js"
    ]);

    expect(result.maxDepth).toBe(2);
  });

  it("reports no blast radius for an isolated file", () => {
    const graph = new DependencyGraph();

    addFile(graph, "src/isolated.js");

    const result = new BlastRadiusAnalyzer().analyze(
      graph,
      "src/isolated.js"
    );

    expect(result.blastRadius).toBe(0);
    expect(result.impacted).toEqual([]);
    expect(result.maxDepth).toBe(0);
  });

  it("rejects an unknown starting path", () => {
    const graph = new DependencyGraph();

    addFile(graph, "src/app.js");

    expect(() =>
      new BlastRadiusAnalyzer().analyze(
        graph,
        "src/missing.js"
      )
    ).toThrow(/unknown file/i);
  });
});