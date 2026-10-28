import { describe, expect, it } from "vitest";

import DependencyGraph from "../../src/engine/DependencyGraph.js";

describe("DependencyGraph hierarchical folder projection", () => {
  it("creates every directory ancestor and attaches files to the deepest one", () => {
    const graph = new DependencyGraph();
    graph.addFileNode({
      path: "packages/vite/src/index.ts",
      loc: 12,
      cyclomaticComplexity: 1
    });

    const elements = graph.toCytoscapeElements();
    const nodes = new Map(
      elements
        .filter((element) => element.group === "nodes")
        .map((element) => [element.data.id, element.data])
    );

    expect(nodes.get("folder::packages")).toMatchObject({
      label: "packages",
      folderPath: "packages"
    });
    expect(nodes.get("folder::packages/vite")).toMatchObject({
      label: "vite",
      folderPath: "packages/vite",
      parent: "folder::packages"
    });
    expect(nodes.get("folder::packages/vite/src")).toMatchObject({
      label: "src",
      folderPath: "packages/vite/src",
      parent: "folder::packages/vite"
    });
    expect(nodes.get("packages/vite/src/index.ts").parent)
      .toBe("folder::packages/vite/src");

    // Visual folders are not added to the analysis graph itself.
    expect(graph.nodes.size).toBe(1);
  });

  it("groups a file at the repository root without inventing a folder", () => {
    const graph = new DependencyGraph();
    graph.addFileNode({
      path: "index.js",
      loc: 5,
      cyclomaticComplexity: 1
    });

    const elements = graph.toCytoscapeElements();
    expect(elements.filter(
      (element) => element.group === "nodes" && element.data.kind === "folder"
    )).toHaveLength(0);
    expect(elements.find(
      (element) => element.group === "nodes" && element.data.id === "index.js"
    ).data.parent).toBeUndefined();
  });

  it("creates the same directory hierarchy for function-call views", () => {
    const graph = new DependencyGraph();
    graph.addFileNode({
      path: "packages/vite/src/index.ts",
      loc: 12,
      cyclomaticComplexity: 1
    });
    const fn = graph.addFunctionNode("packages/vite/src/index.ts", {
      id: "start@1:0",
      name: "start",
      startLine: 1,
      endLine: 2
    });

    const elements = graph.toCytoscapeElements({ view: "calls" });
    const functionNode = elements.find(
      (element) => element.group === "nodes" && element.data.id === fn.id
    );

    expect(functionNode.data.parent).toBe("folder::packages/vite/src");
    expect(elements.some(
      (element) => element.group === "nodes" && element.data.id === "folder::packages/vite/src"
    )).toBe(true);
  });
});
