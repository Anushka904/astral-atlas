import { describe, expect, it } from "vitest";

import DependencyGraph from "../../src/engine/DependencyGraph.js";
import CycleDetector from "../../src/engine/CycleDetector.js";

function makeFile(graph, path) {
  graph.addFileNode({
    path,
    loc: 10,
    cyclomaticComplexity: 1,
    parseStatus: "ok"
  });
}

function makeEdge(graph, source, target) {
  graph.addImportEdge(source, target, {
    specifier: `./${target}`,
    kind: "static"
  });
}

describe("CycleDetector", () => {
  it("detects a self-loop", () => {
    const graph = new DependencyGraph();

    makeFile(graph, "src/self.js");
    makeEdge(graph, "src/self.js", "src/self.js");

    const result = new CycleDetector().detect(graph);

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].selfLoop).toBe(true);
    expect(result.cycles[0].shortestPath).toEqual([
      "src/self.js",
      "src/self.js"
    ]);
  });

  it("finds disjoint cyclic components separately", () => {
    const graph = new DependencyGraph();

    for (const path of [
      "src/a.js",
      "src/b.js",
      "src/c.js",
      "src/x.js",
      "src/y.js",
      "src/isolated.js"
    ]) {
      makeFile(graph, path);
    }

    makeEdge(graph, "src/a.js", "src/b.js");
    makeEdge(graph, "src/b.js", "src/a.js");
    makeEdge(graph, "src/b.js", "src/c.js");
    makeEdge(graph, "src/c.js", "src/b.js");

    makeEdge(graph, "src/x.js", "src/y.js");
    makeEdge(graph, "src/y.js", "src/x.js");

    const result = new CycleDetector().detect(graph);

    expect(result.cycles).toHaveLength(2);

    expect(
      result.cycles.map((cycle) => new Set(cycle.nodes))
    ).toEqual(
      expect.arrayContaining([
        new Set(["src/a.js", "src/b.js", "src/c.js"]),
        new Set(["src/x.js", "src/y.js"])
      ])
    );

    expect(result.cyclicNodes).toHaveLength(5);
    expect(result.stats.cyclicComponents).toBe(2);
  });

  it("returns a shortest cycle path inside a cyclic component", () => {
    const graph = new DependencyGraph();

    for (const path of [
      "src/a.js",
      "src/b.js",
      "src/c.js",
      "src/d.js"
    ]) {
      makeFile(graph, path);
    }

    makeEdge(graph, "src/a.js", "src/b.js");
    makeEdge(graph, "src/b.js", "src/a.js");

    makeEdge(graph, "src/a.js", "src/c.js");
    makeEdge(graph, "src/c.js", "src/d.js");
    makeEdge(graph, "src/d.js", "src/a.js");

    const result = new CycleDetector().detect(graph);

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].shortestPath).toHaveLength(3);
    expect(result.cycles[0].shortestPath[0]).toBe(
      result.cycles[0].shortestPath.at(-1)
    );
  });

  it("processes a 50,000-node chain without recursive DFS", () => {
    const graph = new DependencyGraph();
    const count = 50000;

    for (let index = 0; index < count; index += 1) {
      makeFile(graph, `src/chain/${index}.js`);
    }

    for (let index = 0; index < count - 1; index += 1) {
      makeEdge(
        graph,
        `src/chain/${index}.js`,
        `src/chain/${index + 1}.js`
      );
    }

    const result = new CycleDetector().detect(graph);

    expect(result.cycles).toHaveLength(0);
    expect(result.stats.components).toBe(count);
  }, 10000);
});