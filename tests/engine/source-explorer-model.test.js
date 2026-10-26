import { describe, expect, it } from "vitest";

import {
  createSourceExplorerModel,
  getFileNeighborhood
} from "../../src/engine/sourceExplorerModel.js";

function makeGraph() {
  const file = {
    id: "src/app.js",
    kind: "file",
    path: "src/app.js",
    label: "app.js",
    folder: "src",
    loc: 30,
    tokenCount: 180,
    cyclomaticComplexity: 6,
    parseStatus: "ok"
  };

  const helper = {
    id: "src/helper.js",
    kind: "file",
    path: "src/helper.js",
    label: "helper.js",
    folder: "src",
    loc: 12,
    tokenCount: 67,
    cyclomaticComplexity: 2,
    parseStatus: "ok"
  };

  const unrelated = {
    id: "src/other.js",
    kind: "file",
    path: "src/other.js",
    label: "other.js",
    folder: "src",
    loc: 15,
    tokenCount: 78,
    cyclomaticComplexity: 3,
    parseStatus: "ok"
  };

  const distant = {
    id: "src/distant.js",
    kind: "file",
    path: "src/distant.js",
    label: "distant.js",
    folder: "src",
    loc: 9,
    tokenCount: 43,
    cyclomaticComplexity: 1,
    parseStatus: "ok"
  };

  const isolated = {
    id: "src/isolated.js",
    kind: "file",
    path: "src/isolated.js",
    label: "isolated.js",
    folder: "src",
    loc: 5,
    tokenCount: 20,
    cyclomaticComplexity: 1,
    parseStatus: "ok"
  };

  const graph = {
    nodes: new Map([
      [file.path, file],
      [helper.path, helper],
      [unrelated.path, unrelated],
      [distant.path, distant],
      [isolated.path, isolated]
    ]),

    functionNodes: new Map([
      [
        "function-late",
        {
          id: "function-late",
          filePath: file.path,
          name: "later",
          startLine: 20,
          startColumn: 0,
          cyclomaticComplexity: 2
        }
      ],
      [
        "function-early",
        {
          id: "function-early",
          filePath: file.path,
          name: "run",
          startLine: 4,
          startColumn: 0,
          cyclomaticComplexity: 3
        }
      ],
      [
        "function-helper",
        {
          id: "function-helper",
          filePath: helper.path,
          name: "helper",
          startLine: 1,
          startColumn: 0,
          cyclomaticComplexity: 1
        }
      ]
    ]),

    edges: [
      {
        id: "edge-app-helper",
        source: file.path,
        target: helper.path,
        kind: "import"
      },
      {
        id: "edge-other-app",
        source: unrelated.path,
        target: file.path,
        kind: "import"
      },
      {
        id: "edge-helper-distant",
        source: helper.path,
        target: distant.path,
        kind: "import"
      }
    ]
  };

  return {
    graph,
    file,
    helper,
    unrelated,
    distant,
    isolated
  };
}

describe("createSourceExplorerModel", () => {
  it("returns null for an unknown file", () => {
    const { graph } = makeGraph();

    expect(
      createSourceExplorerModel(graph, "missing.js")
    ).toBeNull();
  });

  it("returns the selected file and its metrics", () => {
    const { graph, file } = makeGraph();

    const model = createSourceExplorerModel(graph, file.path);

    expect(model.file).toBe(file);

    expect(model.metrics).toEqual({
      loc: 30,
      tokenCount: 180,
      cyclomaticComplexity: 6
    });
  });

  it("separates imports from imported-by relationships", () => {
    const { graph, file, helper } = makeGraph();

    const model = createSourceExplorerModel(graph, file.path);

    expect(model.imports).toHaveLength(1);
    expect(model.imports[0].target).toBe(helper.path);

    expect(model.importedBy).toHaveLength(1);
    expect(model.importedBy[0].source).toBe("src/other.js");
  });

  it("includes only functions belonging to the selected file", () => {
    const { graph, file } = makeGraph();

    const model = createSourceExplorerModel(graph, file.path);

    expect(
      model.functions.map((fn) => fn.id)
    ).toEqual([
      "function-early",
      "function-late"
    ]);
  });

  it("orders functions by source position", () => {
    const { graph, file } = makeGraph();

    const model = createSourceExplorerModel(graph, file.path);

    expect(model.functions[0].startLine).toBe(4);
    expect(model.functions[1].startLine).toBe(20);
  });

  it("returns the functions belonging to the helper file", () => {
    const { graph, helper } = makeGraph();

    const model = createSourceExplorerModel(graph, helper.path);

    expect(model.functions).toHaveLength(1);
    expect(model.functions[0].name).toBe("helper");
  });

  it("handles invalid graph inputs without throwing", () => {
    expect(
      createSourceExplorerModel(null, "src/app.js")
    ).toBeNull();

    expect(
      createSourceExplorerModel({}, "src/app.js")
    ).toBeNull();

    expect(
      createSourceExplorerModel(makeGraph().graph, null)
    ).toBeNull();
  });
});

describe("getFileNeighborhood", () => {
  it("includes the selected file, its imports and its importers", () => {
    const { graph, file, helper, unrelated } = makeGraph();

    expect(
      getFileNeighborhood(graph, file.path)
    ).toEqual([
      file.path,
      helper.path,
      unrelated.path
    ]);
  });

  it("does not traverse transitively into a neighbour's dependencies", () => {
    const { graph, file, helper, unrelated, distant } = makeGraph();

    const paths = getFileNeighborhood(graph, file.path);

    expect(paths).toContain(file.path);
    expect(paths).toContain(helper.path);
    expect(paths).toContain(unrelated.path);
    expect(paths).not.toContain(distant.path);
  });

  it("returns only the selected file when it has no neighbours", () => {
    const { graph, isolated } = makeGraph();

    expect(
      getFileNeighborhood(graph, isolated.path)
    ).toEqual([isolated.path]);
  });

  it("includes a file and its immediate dependencies in a leaf neighbourhood", () => {
    const { graph, distant, helper } = makeGraph();

    expect(
      getFileNeighborhood(graph, distant.path)
    ).toEqual([
      distant.path,
      helper.path
    ]);
  });

  it("returns an empty array for an unknown or invalid path", () => {
    const { graph } = makeGraph();

    expect(getFileNeighborhood(graph, "missing.js")).toEqual([]);
    expect(getFileNeighborhood(null, "src/app.js")).toEqual([]);
    expect(getFileNeighborhood(graph, "")).toEqual([]);
  });
});