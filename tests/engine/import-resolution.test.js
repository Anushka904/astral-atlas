import { describe, expect, it } from "vitest";

import {
  parsePathConfig,
  resolveModuleSpecifier
} from "../../src/engine/utils/moduleResolution.js";

import GraphBuilder from "../../src/engine/GraphBuilder.js";

describe("module resolution", () => {
  it("resolves a relative import with an extension", () => {
    const result = resolveModuleSpecifier(
      "src/components/App.jsx",
      "../utils/helpers.js",
      new Set([
        "src/components/App.jsx",
        "src/utils/helpers.js"
      ])
    );

    expect(result.status).toBe("resolved");
    expect(result.targetPath).toBe("src/utils/helpers.js");
  });

  it("resolves an extensionless import to an index file", () => {
    const result = resolveModuleSpecifier(
      "src/App.js",
      "./components",
      new Set([
        "src/App.js",
        "src/components/index.jsx"
      ])
    );

    expect(result.status).toBe("resolved");
    expect(result.targetPath).toBe("src/components/index.jsx");
  });

  it("maps a .js import to .ts in a TypeScript project", () => {
    const result = resolveModuleSpecifier(
      "src/App.ts",
      "./services/data.js",
      new Set([
        "src/App.ts",
        "src/services/data.ts"
      ]),
      {
        baseUrl: "",
        paths: {},
        isTypeScriptProject: true
      }
    );

    expect(result.status).toBe("resolved");
    expect(result.targetPath).toBe("src/services/data.ts");
  });

  it("parses a JSONC config with comments and trailing commas", () => {
    const config = parsePathConfig(
      `{
        // Local aliases
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["src/*"],
          },
        },
      }`,
      { configPath: "tsconfig.json" }
    );

    expect(config.paths["@/*"]).toEqual(["src/*"]);
    expect(config.baseUrl).toBe("");
    expect(config.isTypeScriptProject).toBe(true);
  });

  it("resolves a configured path alias", () => {
    const config = parsePathConfig({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"]
        }
      }
    });

    const result = resolveModuleSpecifier(
      "src/App.tsx",
      "@/components/Card",
      new Set([
        "src/App.tsx",
        "src/components/Card.tsx"
      ]),
      config
    );

    expect(result.status).toBe("resolved");
    expect(result.targetPath).toBe("src/components/Card.tsx");
  });

  it("classifies bare packages as external without resolving graph nodes", () => {
    const result = resolveModuleSpecifier(
      "src/App.js",
      "@scope/toolkit/runtime",
      new Set(["src/App.js"])
    );

    expect(result.status).toBe("external");
    expect(result.packageName).toBe("@scope/toolkit");
  });

  it("rejects relative imports that escape the repository root", () => {
    const result = resolveModuleSpecifier(
      "src/App.js",
      "../../../outside.js",
      new Set(["src/App.js"])
    );

    expect(result.status).toBe("unresolved");
    expect(result.reason).toBe("path-escapes-repository-root");
  });
});

describe("GraphBuilder", () => {
  it("builds internal dependency edges and counts external packages", () => {
    const builder = new GraphBuilder();

    const graph = builder.build([
      {
        path: "src/App.js",
        parseStatus: "ok",
        loc: 10,
        tokenCount: 20,
        cyclomaticComplexity: 2,
        imports: [
          {
            source: "./utils.js",
            kind: "static",
            line: 1,
            importedNames: ["format"],
            localNames: ["format"]
          },
          {
            source: "react",
            kind: "static",
            line: 2,
            importedNames: ["useState"],
            localNames: ["useState"]
          }
        ],
        exports: ["App"],
        functions: []
      },
      {
        path: "src/utils.js",
        parseStatus: "ok",
        loc: 5,
        tokenCount: 8,
        cyclomaticComplexity: 1,
        imports: [],
        exports: ["format"],
        functions: []
      }
    ]);

    expect(graph.nodes.size).toBe(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe("src/App.js");
    expect(graph.edges[0].target).toBe("src/utils.js");

    expect(graph.externalDependencyCount).toBe(1);
    expect(graph.nodes.has("react")).toBe(false);
  });
});