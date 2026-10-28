import { describe, expect, it } from "vitest";

import { filterSourceTree } from "../../src/engine/utils/path.js";

describe("source-tree filtering and cap accounting", () => {
  it("counts every eligible source file omitted by the file cap", () => {
    const tree = [
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "blob",
        path: `src/file-${index}.js`,
        sha: `sha-${index}`,
        size: 10
      })),
      {
        type: "blob",
        path: "README.md",
        sha: "readme",
        size: 20
      },
      {
        type: "tree",
        path: "src",
        sha: "tree"
      },
      {
        type: "blob",
        mode: "120000",
        path: "src/linked.ts",
        sha: "symlink",
        size: 12
      }
    ];

    const result = filterSourceTree(tree, { maxFiles: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.candidateCount).toBe(5);
    expect(result.capApplied).toBe(true);
    expect(result.skippedByReason["file-cap"]).toBe(3);
    expect(result.skippedByReason["unsupported-extension"]).toBe(1);
    expect(result.skippedByReason.symlink).toBe(1);
    expect(result.skippedCount).toBe(5);
  });

  it("does not count directory entries as omitted source files", () => {
    const result = filterSourceTree([
      { type: "tree", path: "src", sha: "tree" },
      { type: "blob", path: "src/index.ts", sha: "source", size: 30 }
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByReason).toEqual(Object.create(null));
  });

  it("does not report a cap when candidate count exactly matches the limit", () => {
    const result = filterSourceTree([
      { type: "blob", path: "src/a.js", sha: "a", size: 10 },
      { type: "blob", path: "src/b.js", sha: "b", size: 10 }
    ], { maxFiles: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.capApplied).toBe(false);
    expect(result.skippedByReason["file-cap"]).toBeUndefined();
  });
});
