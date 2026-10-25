/**
 * Builds the file-dependency graph from FileInfo summaries.
 *
 * WHY:
 * - All file nodes must exist before imports are resolved.
 * - Module resolution is delegated to a reusable utility.
 * - External packages are counted without becoming graph nodes.
 * - Function nodes are file-qualified; calls remain explicitly unresolved
 *   until CallResolver performs scope-aware and cross-file resolution.
 */

import DependencyGraph from "./DependencyGraph.js";

import {
  normalizeModulePath,
  parsePathConfig,
  resolveModuleSpecifier
} from "./utils/moduleResolution.js";

/**
 * Accept the parser pool result or an array of parsed summary records.
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
    "GraphBuilder expects an array of parsed files or a ParserPool result with a results array."
  );
}

/**
 * Extract the source summary from supported input shapes.
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
 * Convert supported config file inputs into a list of path/content pairs.
 *
 * @param {Array<object>|Map<string,string>|object} configFiles
 * @returns {Array<{path:string,content:string|object}>}
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
 * Parse a supplied tsconfig/jsconfig file.
 *
 * If both are present, prefer tsconfig.json. The function doesn't traverse
 * the "extends" chain; only the selected file's own options are applied.
 *
 * @param {object|null} explicitConfig
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

  const normalized = normalizeConfigFiles(configFiles);

  const usable = normalized.filter((item) => {
    const name = item.path.split("/").at(-1).toLowerCase();

    return (
      name === "tsconfig.json" ||
      name === "jsconfig.json"
    );
  });

  usable.sort((a, b) => {
    const aIsTs = a.path.toLowerCase().endsWith("tsconfig.json");
    const bIsTs = b.path.toLowerCase().endsWith("tsconfig.json");

    if (aIsTs !== bIsTs) {
      return aIsTs ? -1 : 1;
    }

    // Prefer the configuration closest to the repository root.
    return a.path.split("/").length -
      b.path.split("/").length;
  });

  const selected = usable[0];

  if (!selected) {
    return parsePathConfig(null);
  }

  if (
    typeof selected.content !== "string" &&
    (!selected.content || typeof selected.content !== "object")
  ) {
    throw new Error(
      `${selected.path} was provided without readable configuration content.`
    );
  }

  return parsePathConfig(selected.content, {
    configPath: selected.path
  });
}

export default class GraphBuilder {
  /**
   * @param {{
   *   pathConfig?:object|string|null
   * }} [options]
   */
  constructor({
    pathConfig = null
  } = {}) {
    this.explicitPathConfig = pathConfig;
    this.pathConfig = parsePathConfig(null);
    this.availablePaths = new Set();
  }

  /**
   * Resolve one import from an importer path.
   *
   * This method is public so callers and tests can inspect resolution
   * decisions without constructing the complete graph.
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
   * Build a DependencyGraph from parsed file summaries.
   *
   * @param {object|Array<object>} parsedInput
   * @param {{
   *   configFiles?:Array<object>|Map<string,string>|object,
   *   pathConfig?:object|string|null,
   *   repoName?:string,
   *   sourceKind?:string,
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

    for (const record of records) {
      const summary = getSummary(record);

      if (!summary) {
        graph.warnings.push({
          code: "MISSING_FILE_SUMMARY",
          message:
            "A parser result did not include a file summary.",
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

      normalizedRecords.push({
        path,
        summary,
        node
      });
    }

    this.availablePaths = new Set(graph.nodes.keys());

    // First pass: create every function node so all function IDs are known
    // before we record their call references.
    const functionIdByFileAndLocalId = new Map();

    for (const record of normalizedRecords) {
      const functions = record.summary.functions ?? [];

      for (const fn of functions) {
        const functionNode = graph.addFunctionNode(
          record.path,
          fn
        );

        functionIdByFileAndLocalId.set(
          `${record.path}\u0000${fn.id ?? `${fn.name}@${fn.startLine}`}`,
          functionNode.id
        );
      }
    }

    // Second pass: preserve calls as references. Do not connect them merely
    // because another function happens to share a name.
    for (const record of normalizedRecords) {
      const functions = record.summary.functions ?? [];

      for (const fn of functions) {
        const sourceFunctionId = functionIdByFileAndLocalId.get(
          `${record.path}\u0000${fn.id ?? `${fn.name}@${fn.startLine}`}`
        );

        if (!sourceFunctionId) {
          continue;
        }

        for (const calleeName of new Set(fn.calls ?? [])) {
          graph.addCallReference(
            sourceFunctionId,
            calleeName,
            { callKind: "name-only" }
          );
        }
      }
    }

    // Third pass: resolve module imports now that every file node exists.
    for (const record of normalizedRecords) {
      const imports = record.summary.imports ?? [];

      for (const importEntry of imports) {
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