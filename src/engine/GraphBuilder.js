/**
 * Build a DependencyGraph from compact parser summaries.
 *
 * WHY:
 * - Every file node must exist before module imports are resolved.
 * - Call references are recorded without name-only guessing.
 * - Function metadata is qualified by file path.
 * - tsconfig/jsconfig contents are forwarded to module resolution.
 */

import DependencyGraph from "./DependencyGraph.js";

import {
  normalizeModulePath,
  parsePathConfig,
  resolveModuleSpecifier
} from "./utils/moduleResolution.js";

/**
 * Normalize parser input.
 *
 * @param {object|Array<object>} input
 * @returns {Array<object>}
 */
function normalizeParsedInput(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (input && Array.isArray(input.results)) {
    return input.results;
  }

  throw new TypeError(
    "GraphBuilder expects an array of file summaries or a ParserPool result."
  );
}

/**
 * Extract the summary from a ParserPool or direct-parser record.
 *
 * @param {object} record
 * @returns {object|null}
 */
function getSummary(record) {
  if (record?.summary && typeof record.summary === "object") {
    return record.summary;
  }

  if (
    record?.cachedSummary &&
    typeof record.cachedSummary === "object"
  ) {
    return record.cachedSummary;
  }

  if (
    record &&
    typeof record.path === "string" &&
    typeof record.parseStatus === "string"
  ) {
    return record;
  }

  return null;
}

/**
 * Normalize supported configuration input shapes.
 *
 * @param {Array<object>|Map<string,string>|object|null} configFiles
 * @returns {Array<{path:string,content:unknown}>}
 */
function normalizeConfigFiles(configFiles) {
  if (!configFiles) {
    return [];
  }

  if (configFiles instanceof Map) {
    return [...configFiles.entries()].map(
      ([path, content]) => ({ path, content })
    );
  }

  if (Array.isArray(configFiles)) {
    return configFiles
      .filter((item) => item && typeof item.path === "string")
      .map((item) => ({
        path: item.path,
        content:
          item.content ??
          item.text ??
          item.source ??
          item.data
      }));
  }

  if (typeof configFiles === "object") {
    return Object.entries(configFiles).map(
      ([path, content]) => ({ path, content })
    );
  }

  return [];
}

/**
 * Select the configuration used by this graph build.
 *
 * This initial integration uses one project-level configuration. It supports
 * a typical root tsconfig/jsconfig and nested configurations when no
 * higher-priority root TypeScript config is available. It does not yet
 * implement a complete per-package "extends" inheritance system.
 *
 * @param {object|string|null} explicitConfig
 * @param {Array<object>} configFiles
 * @returns {object}
 */
function selectPathConfig(explicitConfig, configFiles) {
  if (explicitConfig) {
    if (
      typeof explicitConfig === "object" &&
      explicitConfig.paths &&
      typeof explicitConfig.baseUrl === "string"
    ) {
      return explicitConfig;
    }

    return parsePathConfig(explicitConfig);
  }

  const candidates = normalizeConfigFiles(configFiles)
    .filter((item) => {
      const fileName =
        item.path.split("/").at(-1).toLowerCase();

      return (
        fileName === "tsconfig.json" ||
        fileName === "jsconfig.json"
      );
    });

  candidates.sort((a, b) => {
    const aTs = a.path.toLowerCase().endsWith("tsconfig.json");
    const bTs = b.path.toLowerCase().endsWith("tsconfig.json");

    if (aTs !== bTs) {
      return aTs ? -1 : 1;
    }

    const depthDifference =
      a.path.split("/").length -
      b.path.split("/").length;

    return depthDifference || a.path.localeCompare(b.path);
  });

  const selected = candidates[0];

  if (!selected) {
    return parsePathConfig(null);
  }

  if (
    typeof selected.content !== "string" &&
    (!selected.content ||
      typeof selected.content !== "object")
  ) {
    throw new Error(
      `${selected.path} was supplied without readable configuration content.`
    );
  }

  return parsePathConfig(selected.content, {
    configPath: selected.path
  });
}

export default class GraphBuilder {
  /**
   * @param {{pathConfig?:object|string|null}} [options]
   */
  constructor({
    pathConfig = null
  } = {}) {
    this.explicitPathConfig = pathConfig;
    this.pathConfig = parsePathConfig(null);
    this.availablePaths = new Set();
  }

  /**
   * Resolve an import against this builder's current path set.
   *
   * @param {string} importerPath
   * @param {string|object} importEntry
   * @param {object} [pathConfig]
   * @returns {object}
   */
  resolveImport(
    importerPath,
    importEntry,
    pathConfig = this.pathConfig
  ) {
    return resolveModuleSpecifier(
      importerPath,
      importEntry,
      this.availablePaths,
      pathConfig
    );
  }

  /**
   * Build the graph.
   *
   * @param {object|Array<object>} parsedInput
   * @param {{
   *   configFiles?:Array<object>|Map<string,string>|object,
   *   pathConfig?:object|string|null,
   *   repoName?:string|null,
   *   sourceKind?:string|null,
   *   repoUrl?:string|null,
   *   branch?:string|null
   * }} [options]
   * @returns {DependencyGraph}
   */
  build(parsedInput, {
    configFiles = [],
    pathConfig = this.explicitPathConfig,
    repoName = null,
    sourceKind = null,
    repoUrl = null,
    branch = null
  } = {}) {
    const records = normalizeParsedInput(parsedInput);

    this.pathConfig = selectPathConfig(
      pathConfig,
      configFiles
    );

    const graph = new DependencyGraph();

    graph.metadata = {
      repoName,
      sourceKind,
      repoUrl,
      branch,
      baseUrl: this.pathConfig.baseUrl,
      pathConfigFile: this.pathConfig.configPath
    };

    const normalizedRecords = [];

    // Pass 1: create all file nodes before resolving any relationships.
    for (const record of records) {
      const summary = getSummary(record);

      if (!summary) {
        graph.warnings.push({
          code: "MISSING_FILE_SUMMARY",
          message: "A parser result did not include a file summary.",
          path: record?.path ?? null
        });

        continue;
      }

      const path = normalizeModulePath(
        summary.path ?? record.path
      );

      if (!path) {
        graph.warnings.push({
          code: "INVALID_REPOSITORY_PATH",
          message: "A file path was rejected as unsafe.",
          path: summary.path ?? record.path ?? null
        });

        continue;
      }

      if (graph.nodes.has(path)) {
        graph.warnings.push({
          code: "DUPLICATE_FILE_PATH",
          message:
            "A duplicate file path was encountered; the later copy was ignored.",
          path
        });

        continue;
      }

      const node = graph.addFileNode({
        ...summary,
        path,
        sha: summary.sha ?? record.sha ?? null
      });

      // DependencyGraph owns graph/node creation. These additional summary
      // fields are attached here so older graph model methods stay compatible.
      node.exportBindings = [
        ...(summary.exportBindings ?? [])
      ];

      normalizedRecords.push({
        path,
        summary,
        node
      });
    }

    this.availablePaths = new Set(graph.nodes.keys());

    const functionIdByFileAndLocalId = new Map();

    // Pass 2: create every function node before recording call references.
    for (const record of normalizedRecords) {
      for (const fn of record.summary.functions ?? []) {
        const functionNode = graph.addFunctionNode(
          record.path,
          fn
        );

        functionNode.bindingId = fn.bindingId ?? null;
        functionNode.exportNames = [...(fn.exportNames ?? [])];
        functionNode.classExportNames = [
          ...(fn.classExportNames ?? [])
        ];
        functionNode.className = fn.className ?? null;
        functionNode.classBindingId =
          fn.classBindingId ?? null;
        functionNode.ownerBindingId =
          fn.ownerBindingId ?? null;
        functionNode.startColumn = fn.startColumn ?? 0;
        functionNode.endColumn = fn.endColumn ?? 0;

        const localId =
          fn.id ??
          `${fn.name ?? "anonymous"}@${fn.startLine ?? 1}:${fn.startColumn ?? 0}`;

        functionIdByFileAndLocalId.set(
          `${record.path}\u0000${localId}`,
          functionNode.id
        );
      }
    }

    // Pass 3: record calls with their binding/receiver metadata.
    for (const record of normalizedRecords) {
      for (const fn of record.summary.functions ?? []) {
        const localId =
          fn.id ??
          `${fn.name ?? "anonymous"}@${fn.startLine ?? 1}:${fn.startColumn ?? 0}`;

        const sourceFunctionId =
          functionIdByFileAndLocalId.get(
            `${record.path}\u0000${localId}`
          );

        if (!sourceFunctionId) {
          continue;
        }

        for (const call of fn.calls ?? []) {
          // Backward compatibility for summaries produced by the earlier
          // name-only extractor.
          const callData = typeof call === "string"
            ? {
                calleeName: call,
                callKind: "identifier",
                bindingChain: []
              }
            : call;

          const calleeName = callData.calleeName;

          if (
            typeof calleeName !== "string" ||
            !calleeName
          ) {
            continue;
          }

          const reference = graph.addCallReference(
            sourceFunctionId,
            calleeName,
            {
              line: callData.line ?? null,
              receiverName: callData.receiverName ?? null,
              callKind: callData.callKind ?? "name-only"
            }
          );

          // Preserve richer call-site metadata for CallResolver.
          Object.assign(reference, {
            ...callData,
            targetFunctionIds: [],
            status: "unresolved"
          });
        }
      }
    }

    // Pass 4: resolve all imports after every file node exists.
    for (const record of normalizedRecords) {
      for (const importEntry of record.summary.imports ?? []) {
        const resolution = this.resolveImport(
          record.path,
          importEntry
        );

        if (resolution.status === "resolved") {
          graph.addImportEdge(
            record.path,
            resolution.targetPath,
            {
              ...importEntry,
              specifier: resolution.specifier
            }
          );

          continue;
        }

        if (resolution.status === "external") {
          graph.addExternalDependency(
            resolution.packageName,
            record.path,
            resolution.specifier
          );

          continue;
        }

        graph.unresolvedImports.push({
          sourcePath: record.path,
          specifier: resolution.specifier,
          line: importEntry.line ?? null,
          kind: importEntry.kind ?? "static",
          reason: resolution.reason ?? "unresolved",
          candidates: resolution.candidates ?? []
        });
      }
    }

    return graph;
  }
}