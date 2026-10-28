import { describe, expect, it } from "vitest";

import {
  prepareGraphNavigationElements,
  getInitialExpandedFolders,
  getVisibleGraphElements
} from "../../src/engine/GraphNavigationModel.js";

/**
 * A small synthetic graph covering:
 * - Two folder clusters
 * - Two files inside lib
 * - One file inside tests
 * - One root-level file
 * - Internal and cross-folder dependencies
 * - A file marked as participating in a cycle
 *
 * This fixture uses the same Cytoscape element structure expected by
 * GraphNavigationModel.js.
 */
function makeElements() {
  return [
    {
      group: "nodes",
      data: {
        id: "folder::lib",
        kind: "folder",
        label: "lib"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "folder::tests",
        kind: "folder",
        label: "tests"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "lib/a.js",
        path: "lib/a.js",
        kind: "file",
        parent: "folder::lib",
        cyclomaticComplexity: 3,
        parseStatus: "ok"
      },
      classes: "file-node cycle-node"
    },
    {
      group: "nodes",
      data: {
        id: "lib/b.js",
        path: "lib/b.js",
        kind: "file",
        parent: "folder::lib",
        cyclomaticComplexity: 2,
        parseStatus: "ok"
      },
      classes: "file-node"
    },
    {
      group: "nodes",
      data: {
        id: "tests/t.js",
        path: "tests/t.js",
        kind: "file",
        parent: "folder::tests",
        cyclomaticComplexity: 2,
        parseStatus: "ok"
      },
      classes: "file-node"
    },
    {
      group: "nodes",
      data: {
        id: "root.js",
        path: "root.js",
        kind: "file",
        cyclomaticComplexity: 1,
        parseStatus: "ok"
      },
      classes: "file-node"
    },
    {
      group: "edges",
      data: {
        id: "internal-lib",
        source: "lib/a.js",
        target: "lib/b.js",
        kind: "import",
        importCount: 2
      },
      classes: "dependency-edge"
    },
    {
      group: "edges",
      data: {
        id: "cross-lib-tests-1",
        source: "lib/a.js",
        target: "tests/t.js",
        kind: "import",
        importCount: 3
      },
      classes: "dependency-edge"
    },
    {
      group: "edges",
      data: {
        id: "cross-lib-tests-2",
        source: "lib/b.js",
        target: "tests/t.js",
        kind: "import",
        importCount: 1
      },
      classes: "dependency-edge"
    },
    {
      group: "edges",
      data: {
        id: "root-lib",
        source: "root.js",
        target: "lib/a.js",
        kind: "import",
        importCount: 1
      },
      classes: "dependency-edge"
    }
  ];
}

function prepareFixture() {
  return prepareGraphNavigationElements(
    makeElements(),
    "dependencies"
  );
}

function makeNestedElements() {
  return [
    {
      group: "nodes",
      data: {
        id: "folder::packages",
        label: "packages",
        baseLabel: "packages",
        folderPath: "packages",
        kind: "folder"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "folder::packages/vite",
        label: "vite",
        baseLabel: "vite",
        folderPath: "packages/vite",
        kind: "folder",
        parent: "folder::packages"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "folder::packages/vite/src",
        label: "src",
        baseLabel: "src",
        folderPath: "packages/vite/src",
        kind: "folder",
        parent: "folder::packages/vite"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "folder::playground",
        label: "playground",
        baseLabel: "playground",
        folderPath: "playground",
        kind: "folder"
      },
      classes: "folder-cluster"
    },
    {
      group: "nodes",
      data: {
        id: "packages/vite/src/a.ts",
        path: "packages/vite/src/a.ts",
        kind: "file",
        parent: "folder::packages/vite/src"
      },
      classes: "file-node"
    },
    {
      group: "nodes",
      data: {
        id: "packages/vite/src/b.ts",
        path: "packages/vite/src/b.ts",
        kind: "file",
        parent: "folder::packages/vite/src"
      },
      classes: "file-node cycle-node"
    },
    {
      group: "nodes",
      data: {
        id: "playground/main.ts",
        path: "playground/main.ts",
        kind: "file",
        parent: "folder::playground"
      },
      classes: "file-node"
    },
    {
      group: "edges",
      data: {
        id: "nested-internal",
        source: "packages/vite/src/a.ts",
        target: "packages/vite/src/b.ts",
        kind: "import",
        importCount: 2
      },
      classes: "dependency-edge"
    },
    {
      group: "edges",
      data: {
        id: "nested-cross",
        source: "playground/main.ts",
        target: "packages/vite/src/a.ts",
        kind: "import",
        importCount: 3
      },
      classes: "dependency-edge"
    }
  ];
}

describe("prepareGraphNavigationElements", () => {
  it("counts files belonging to each folder", () => {
    const elements = prepareFixture();

    const lib = elements.find(
      (element) => element.data?.id === "folder::lib"
    );

    const tests = elements.find(
      (element) => element.data?.id === "folder::tests"
    );

    expect(lib.data.fileCount).toBe(2);
    expect(tests.data.fileCount).toBe(1);
  });

  it("counts weighted internal relationships", () => {
    const elements = prepareFixture();

    const lib = elements.find(
      (element) => element.data?.id === "folder::lib"
    );

    expect(lib.data.internalRelationshipCount).toBe(2);
  });

  it("preserves cycle information in folder summaries", () => {
    const elements = prepareFixture();

    const lib = elements.find(
      (element) => element.data?.id === "folder::lib"
    );

    expect(lib.data.cycleCount).toBe(1);
  });

  it("does not mutate the input elements", () => {
    const original = makeElements();
    const originalSnapshot = structuredClone(original);

    prepareGraphNavigationElements(
      original,
      "dependencies"
    );

    expect(original).toEqual(originalSnapshot);
  });
});

describe("getInitialExpandedFolders", () => {
  it("expands folder clusters for a small repository", () => {
    const expanded = getInitialExpandedFolders(
      prepareFixture(),
      20
    );

    expect([...expanded].sort()).toEqual([
      "folder::lib",
      "folder::tests"
    ]);
  });

  it("collapses folders for a repository exceeding the threshold", () => {
    const expanded = getInitialExpandedFolders(
      prepareFixture(),
      100
    );

    expect(expanded.size).toBe(0);
  });

  it("returns an empty set when there are no folder clusters", () => {
    const elements = [
      {
        group: "nodes",
        data: {
          id: "root.js",
          path: "root.js",
          kind: "file"
        }
      }
    ];

    expect(
      getInitialExpandedFolders(elements, 100).size
    ).toBe(0);
  });
});

describe("nested directory navigation", () => {
  it("counts descendant files and relationships at every ancestor", () => {
    const elements = prepareGraphNavigationElements(
      makeNestedElements(),
      "dependencies"
    );
    const byId = new Map(
      elements
        .filter((element) => element.group === "nodes")
        .map((element) => [element.data.id, element.data])
    );

    expect(byId.get("folder::packages")).toMatchObject({
      fileCount: 2,
      internalRelationshipCount: 2,
      cycleCount: 1
    });
    expect(byId.get("folder::packages/vite")).toMatchObject({
      fileCount: 2,
      internalRelationshipCount: 2,
      cycleCount: 1
    });
    expect(byId.get("folder::packages/vite/src")).toMatchObject({
      fileCount: 2,
      internalRelationshipCount: 2,
      cycleCount: 1
    });
    expect(byId.get("folder::playground").fileCount).toBe(1);
  });

  it("shows only root directories while a large graph starts collapsed", () => {
    const visible = getVisibleGraphElements(
      prepareGraphNavigationElements(makeNestedElements()),
      new Set()
    );
    const ids = visible
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(ids).toEqual([
      "folder::packages",
      "folder::playground"
    ]);

    const aggregate = visible.find(
      (element) => element.group === "edges"
    );
    expect(aggregate.data.source).toBe("folder::playground");
    expect(aggregate.data.target).toBe("folder::packages");
    expect(aggregate.data.importCount).toBe(3);
  });

  it("reveals exactly one additional directory level when its parent expands", () => {
    const visible = getVisibleGraphElements(
      prepareGraphNavigationElements(makeNestedElements()),
      new Set(["folder::packages"])
    );
    const ids = visible
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(ids).toContain("folder::packages/vite");
    expect(ids).not.toContain("folder::packages/vite/src");
    expect(ids).not.toContain("packages/vite/src/a.ts");
    expect(ids).toContain("folder::playground");
  });

  it("shows files only when every directory ancestor is expanded", () => {
    const prepared = prepareGraphNavigationElements(makeNestedElements());
    const visibleBeforeLeafExpand = getVisibleGraphElements(
      prepared,
      new Set([
        "folder::packages",
        "folder::packages/vite"
      ])
    );
    const beforeIds = visibleBeforeLeafExpand
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(beforeIds).toContain("folder::packages/vite/src");
    expect(beforeIds).not.toContain("packages/vite/src/a.ts");

    const visibleAfterLeafExpand = getVisibleGraphElements(
      prepared,
      new Set([
        "folder::packages",
        "folder::packages/vite",
        "folder::packages/vite/src"
      ])
    );
    const afterIds = visibleAfterLeafExpand
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(afterIds).toContain("packages/vite/src/a.ts");
    expect(afterIds).toContain("packages/vite/src/b.ts");
  });

  it("restores original edges when every nested folder is expanded", () => {
    const prepared = prepareGraphNavigationElements(makeNestedElements());
    const visible = getVisibleGraphElements(
      prepared,
      new Set([
        "folder::packages",
        "folder::packages/vite",
        "folder::packages/vite/src",
        "folder::playground"
      ])
    );
    const fileIds = visible
      .filter((element) => element.group === "nodes" && element.data.kind !== "folder")
      .map((element) => element.data.id);
    const edgeIds = visible
      .filter((element) => element.group === "edges")
      .map((element) => element.data.id);

    expect(fileIds.sort()).toEqual([
      "packages/vite/src/a.ts",
      "packages/vite/src/b.ts",
      "playground/main.ts"
    ].sort());
    expect(edgeIds.sort()).toEqual(["nested-cross", "nested-internal"].sort());
    expect(edgeIds.some((id) => id.startsWith("atlas-aggregate"))).toBe(false);
  });
});

describe("getVisibleGraphElements", () => {
  it("shows collapsed folder summaries and root files", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(),
      "dependencies"
    );

    const ids = visible
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(ids).toContain("folder::lib");
    expect(ids).toContain("folder::tests");
    expect(ids).toContain("root.js");

    expect(ids).not.toContain("lib/a.js");
    expect(ids).not.toContain("lib/b.js");
    expect(ids).not.toContain("tests/t.js");
  });

  it("aggregates repeated cross-folder imports", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(),
      "dependencies"
    );

    const edge = visible.find(
      (element) =>
        element.group === "edges" &&
        element.data.source === "folder::lib" &&
        element.data.target === "folder::tests"
    );

    expect(edge).toBeDefined();
    expect(edge.data.importCount).toBe(4);
    expect(edge.data.label).toBe("×4");
  });

  it("does not generate self-loops inside collapsed folders", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(),
      "dependencies"
    );

    const selfLoops = visible.filter(
      (element) =>
        element.group === "edges" &&
        element.data.source === element.data.target
    );

    expect(selfLoops).toHaveLength(0);
  });

  it("includes file and internal relationship counts in folder labels", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(),
      "dependencies"
    );

    const lib = visible.find(
      (element) =>
        element.group === "nodes" &&
        element.data.id === "folder::lib"
    );

    expect(lib.data.label).toContain("lib");
    expect(lib.data.label).toContain("2 files");
    expect(lib.data.label).toContain("2 internal imports");
    expect(lib.data.label).toContain("1 cyclic files/functions");
    expect(lib.classes).toContain("folder-collapsed");
  });

  it("shows child files and internal edges when a folder is expanded", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(["folder::lib"]),
      "dependencies"
    );

    const ids = visible
      .filter((element) => element.group === "nodes")
      .map((element) => element.data.id);

    expect(ids).toContain("lib/a.js");
    expect(ids).toContain("lib/b.js");
    expect(ids).not.toContain("tests/t.js");

    const internalEdge = visible.find(
      (element) =>
        element.group === "edges" &&
        element.data.id === "internal-lib"
    );

    expect(internalEdge).toBeDefined();
    expect(internalEdge.data.importCount).toBe(2);
  });

  it("retains relationships from expanded files to collapsed folders", () => {
    const visible = getVisibleGraphElements(
      prepareFixture(),
      new Set(["folder::lib"]),
      "dependencies"
    );

    const edge = visible.find(
      (element) =>
        element.group === "edges" &&
        element.data.source === "lib/a.js" &&
        element.data.target === "folder::tests"
    );

    expect(edge).toBeDefined();
    expect(edge.data.importCount).toBe(3);
  });

  it("handles null input without throwing", () => {
    expect(
      getVisibleGraphElements(
        null,
        new Set(),
        "dependencies"
      )
    ).toEqual([]);
  });
});


describe("large-graph folder presentation classes", () => {
  it("marks expanded root and nested folders distinctly without hiding them", () => {
    const elements = prepareGraphNavigationElements(makeNestedElements());
    const rootId = "folder::packages";
    const nestedId = "folder::packages/vite";
    const visible = getVisibleGraphElements(
      elements,
      new Set([rootId, nestedId]),
      "dependencies"
    );

    const root = visible.find((element) => element.data?.id === rootId);
    const nested = visible.find((element) => element.data?.id === nestedId);

    expect(root).toBeTruthy();
    expect(nested).toBeTruthy();
    expect(root.classes.split(/\s+/)).toContain("folder-expanded");
    expect(root.classes.split(/\s+/)).toContain("folder-depth-root");
    expect(nested.classes.split(/\s+/)).toContain("folder-expanded");
    expect(nested.classes.split(/\s+/)).toContain("folder-depth-nested");
  });

  it("removes the expanded class when a folder is collapsed", () => {
    const elements = prepareGraphNavigationElements(makeNestedElements());
    const visible = getVisibleGraphElements(
      elements,
      new Set(),
      "dependencies"
    );

    const root = visible.find(
      (element) => element.data?.id === "folder::packages"
    );

    expect(root).toBeTruthy();
    expect(root.classes.split(/\s+/)).toContain("folder-collapsed");
    expect(root.classes.split(/\s+/)).not.toContain("folder-expanded");
  });
});
