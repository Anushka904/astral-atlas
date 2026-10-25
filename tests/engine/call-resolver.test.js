import { describe, expect, it } from "vitest";

import { parseSource } from "../../src/engine/parser/parseSource.js";
import GraphBuilder from "../../src/engine/GraphBuilder.js";
import CallResolver from "../../src/engine/CallResolver.js";

/**
 * Parse multiple source files and construct the dependency graph.
 *
 * @param {Array<{path:string,source:string}>} sources
 * @param {Array<object>} [configFiles]
 * @returns {object}
 */
function makeGraph(sources, configFiles = []) {
  const parsedFiles = sources.map(({ path, source }) => ({
    path,
    summary: parseSource(source, { path })
  }));

  return new GraphBuilder().build(parsedFiles, {
    configFiles
  });
}

function getCall(graph, calleeName) {
  return graph.callReferences.find(
    (item) => item.calleeName === calleeName
  );
}

function getTargetFunctions(graph, reference) {
  return reference.targetFunctionIds.map(
    (id) => graph.functionNodes.get(id)
  );
}

describe("CallResolver", () => {
  it("resolves a direct local function call by binding identity", () => {
    const graph = makeGraph([
      {
        path: "src/math.js",
        source: `
          export function add(a, b) {
            return a + b;
          }

          export function calculate() {
            return add(2, 3);
          }
        `
      }
    ]);

    const result = new CallResolver().resolve(graph);
    const reference = getCall(graph, "add");

    expect(reference).toBeDefined();
    expect(reference.status).toBe("resolved");
    expect(getTargetFunctions(graph, reference)[0].name).toBe("add");
    expect(result.stats.resolved).toBeGreaterThanOrEqual(1);
  });

  it("resolves a simple variable alias without relying on names alone", () => {
    const graph = makeGraph([
      {
        path: "src/aliases.js",
        source: `
          function originalSave() {
            return true;
          }

          const firstAlias = originalSave;
          const secondAlias = firstAlias;

          export function run() {
            return secondAlias();
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "secondAlias");

    expect(reference).toBeDefined();
    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference)[0].name
    ).toBe("originalSave");
  });

  it("distinguishes a shadowed local function from an outer same-named function", () => {
    const graph = makeGraph([
      {
        path: "src/shadow.js",
        source: `
          function save() {
            return "outer";
          }

          export function run() {
            function save() {
              return "inner";
            }

            return save();
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "save");
    const targets = getTargetFunctions(graph, reference);

    expect(reference.status).toBe("resolved");
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("save");

    // The inner save declaration occurs after the outer declaration.
    expect(targets[0].startLine).toBeGreaterThan(2);
  });

  it("resolves a named import that was renamed locally", () => {
    const graph = makeGraph([
      {
        path: "src/app.js",
        source: `
          import { save as persist } from "./store.js";

          export function run() {
            return persist();
          }
        `
      },
      {
        path: "src/store.js",
        source: `
          export function save() {
            return true;
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "persist");

    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference).map(
        (fn) => fn.name
      )
    ).toEqual(["save"]);
  });

  it("follows a named re-export before resolving an imported call", () => {
    const graph = makeGraph([
      {
        path: "src/app.js",
        source: `
          import { persist as saveNow } from "./index.js";

          export function run() {
            return saveNow();
          }
        `
      },
      {
        path: "src/index.js",
        source: `
          export { save as persist } from "./store.js";
        `
      },
      {
        path: "src/store.js",
        source: `
          export function save() {
            return true;
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "saveNow");

    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference)[0].name
    ).toBe("save");
  });

  it("resolves this.method() to a method in the same class", () => {
    const graph = makeGraph([
      {
        path: "src/counter.js",
        source: `
          export class Counter {
            increment() {
              return 1;
            }

            update() {
              return this.increment();
            }
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "increment");

    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference)[0].name
    ).toBe("Counter.increment");
  });

  it("resolves object-literal methods when the receiver binding is known", () => {
    const graph = makeGraph([
      {
        path: "src/handlers.js",
        source: `
          const handlers = {
            save() {
              return true;
            }
          };

          export function run() {
            return handlers.save();
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "save");

    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference)[0].name
    ).toBe("save");
  });

  it("resolves methods through an imported class and a simple instance", () => {
    const graph = makeGraph([
      {
        path: "src/app.js",
        source: `
          import { Store as Vault } from "./store.js";

          export function run() {
            const store = new Vault();
            return store.save();
          }
        `
      },
      {
        path: "src/store.js",
        source: `
          export class Store {
            save() {
              return true;
            }
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "save");

    expect(reference.status).toBe("resolved");
    expect(
      getTargetFunctions(graph, reference)[0].name
    ).toBe("Store.save");
  });

  it("does not invent a target for a dynamic computed member call", () => {
    const graph = makeGraph([
      {
        path: "src/dynamic.js",
        source: `
          export function run(object, key) {
            return object[key]();
          }
        `
      }
    ]);

    new CallResolver().resolve(graph);

    const reference = getCall(graph, "<computed>");

    expect(reference).toBeDefined();
    expect(reference.status).toBe("unresolved");
    expect(reference.targetFunctionIds).toEqual([]);
    expect(reference.resolutionReason).toBe(
      "dynamic-call-target"
    );
  });
});