/**
 * Dependency graph data model for Astral Atlas.
 *
 * WHY:
 * - File imports and function calls are different graph relationships.
 * - External packages are counted but are not represented as file nodes.
 * - Folder clusters are a visualization concern, not algorithm vertices.
 * - Keeping these concepts separate makes cycle detection and impact
 *   calculations simpler and less error-prone.
 */

const CLUSTER_COLORS = [
  "#E2553D",
  "#C9825B",
  "#E5A0B5",
  "#B29AE8",
  "#9571B8",
  "#AD718F",
  "#A84D61",
  "#80505D",
  "#D6A18D",
  "#8C6B9A",
  "#E09B76",
  "#B9A0B8"
];

/**
 * Derive a top-level folder name from a repository-relative path.
 *
 * @param {string} path
 * @returns {string}
 */
export function getTopLevelFolder(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const firstSlash = normalized.indexOf("/");

  return firstSlash === -1
    ? "(root)"
    : normalized.slice(0, firstSlash);
}

/**
 * Derive a display label from a repository-relative path.
 *
 * @param {string} path
 * @returns {string}
 */
function getFileLabel(path) {
  const segments = String(path).split("/");
  return segments.at(-1) || path;
}

/**
 * Return a deterministic colour for a cluster name.
 *
 * @param {string} name
 * @returns {string}
 */
function getClusterColor(name) {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }

  return CLUSTER_COLORS[
    Math.abs(hash) % CLUSTER_COLORS.length
  ];
}

export default class DependencyGraph {
  constructor() {
    /** @type {Map<string, object>} */
    this.nodes = new Map();

    /** @type {Array<object>} */
    this.edges = [];

    this.edgeByKey = new Map();

    /** @type {Map<string, object>} */
    this.functionNodes = new Map();

    /** @type {Array<object>} */
    this.callReferences = [];

    /**
     * Map package name -> aggregate external dependency record.
     * External packages never enter this.nodes.
     */
    this.externalDependencies = new Map();

    this.unresolvedImports = [];
    this.warnings = [];
    this.metadata = {};
  }

  /**
   * Add or replace a file node.
   *
   * @param {{
   *   path:string,
   *   sha?:string|null,
   *   loc?:number,
   *   tokenCount?:number,
   *   cyclomaticComplexity?:number,
   *   parseStatus?:string,
   *   warning?:string|null,
   *   imports?:object[],
   *   exports?:string[],
   *   functions?:object[]
   * }} file
   * @returns {object}
   */
  addFileNode(file) {
    if (!file || typeof file.path !== "string" || !file.path) {
      throw new TypeError(
        "A file node must have a non-empty repository-relative path."
      );
    }

    const path = file.path.replace(/\\/g, "/");
    const folder = getTopLevelFolder(path);

    const node = {
      id: path,
      path,
      label: getFileLabel(path),
      kind: "file",
      folder,
      clusterColor: getClusterColor(folder),
      sha: file.sha ?? null,
      loc: Number.isFinite(file.loc) ? file.loc : 0,
      tokenCount: Number.isFinite(file.tokenCount)
        ? file.tokenCount
        : 0,
      cyclomaticComplexity: Number.isFinite(
        file.cyclomaticComplexity
      )
        ? file.cyclomaticComplexity
        : 1,
      parseStatus: file.parseStatus ?? "ok",
      warning: file.warning ?? null,
      imports: [...(file.imports ?? [])],
      exports: [...(file.exports ?? [])],
      functions: [...(file.functions ?? [])]
    };

    this.nodes.set(path, node);

    return node;
  }

  /**
   * Add a directed import relationship.
   *
   * Direction: importer -> imported module.
   * Multiple import statements between the same two files are aggregated.
   *
   * @param {string} sourcePath
   * @param {string} targetPath
   * @param {object} importInfo
   * @returns {object}
   */
  addImportEdge(sourcePath, targetPath, importInfo = {}) {
    if (!this.nodes.has(sourcePath)) {
      throw new Error(`Unknown importer node: ${sourcePath}`);
    }

    if (!this.nodes.has(targetPath)) {
      throw new Error(`Unknown imported node: ${targetPath}`);
    }

    const key = JSON.stringify([sourcePath, targetPath]);

    let edge = this.edgeByKey.get(key);

    if (!edge) {
      edge = {
        id: `import:${sourcePath}->${targetPath}`,
        source: sourcePath,
        target: targetPath,
        kind: "import",
        imports: [],
        lines: []
      };

      this.edgeByKey.set(key, edge);
      this.edges.push(edge);
    }

    edge.imports.push({
      specifier: importInfo.specifier ?? null,
      importKind: importInfo.kind ?? "static",
      line: importInfo.line ?? null,
      importedNames: [...(importInfo.importedNames ?? [])],
      localNames: [...(importInfo.localNames ?? [])],
      typeOnly: importInfo.typeOnly === true
    });

    if (Number.isInteger(importInfo.line)) {
      edge.lines.push(importInfo.line);
    }

    return edge;
  }

  /**
   * Add a statically extracted function to the function-call graph.
   *
   * The ID is qualified by the containing file. A plain function name is
   * not a unique identity across a repository.
   *
   * @param {string} filePath
   * @param {object} fn
   * @returns {object}
   */
  addFunctionNode(filePath, fn) {
    if (!this.nodes.has(filePath)) {
      throw new Error(`Unknown function owner file: ${filePath}`);
    }

    const name = fn.name ?? "anonymous";
    const line = fn.startLine ?? 1;
    const localId = fn.id ?? `${name}@${line}`;
    const id = `${filePath}::${localId}`;

    const node = {
      id,
      kind: "function",
      filePath,
      name,
      localId,
      startLine: line,
      endLine: fn.endLine ?? line,
      cyclomaticComplexity: fn.cyclomaticComplexity ?? 1,
      calls: [...new Set(fn.calls ?? [])],
      async: fn.async === true,
      generator: fn.generator === true,
      functionKind: fn.kind ?? "function"
    };

    this.functionNodes.set(id, node);

    return node;
  }

  /**
   * Record an extracted call before attempting target resolution.
   *
   * This method intentionally does not connect calls to functions merely
   * because their names match. CallResolver will add target IDs when it has
   * sufficient static evidence.
   *
   * @param {string} sourceFunctionId
   * @param {string} calleeName
   * @param {{line?:number|null, receiverName?:string|null, callKind?:string}} [data]
   * @returns {object}
   */
  addCallReference(sourceFunctionId, calleeName, data = {}) {
    if (!this.functionNodes.has(sourceFunctionId)) {
      throw new Error(
        `Unknown calling function: ${sourceFunctionId}`
      );
    }

    const reference = {
      id: `call-ref:${this.callReferences.length + 1}`,
      sourceFunctionId,
      calleeName,
      receiverName: data.receiverName ?? null,
      callKind: data.callKind ?? "name-only",
      line: data.line ?? null,
      targetFunctionIds: [],
      status: "unresolved"
    };

    this.callReferences.push(reference);

    return reference;
  }

  /**
   * Update a call reference after static resolution.
   *
   * @param {string} referenceId
   * @param {{
   *   targetFunctionIds?:string[],
   *   status?:"resolved"|"ambiguous"|"unresolved",
   *   resolutionReason?:string|null
   * }} result
   * @returns {object}
   */
  resolveCallReference(referenceId, result) {
    const reference = this.callReferences.find(
      (item) => item.id === referenceId
    );

    if (!reference) {
      throw new Error(`Unknown call reference: ${referenceId}`);
    }

    const validStatuses = new Set([
      "resolved",
      "ambiguous",
      "unresolved"
    ]);

    const targets = [
      ...new Set(result.targetFunctionIds ?? [])
    ].filter((id) => this.functionNodes.has(id));

    const status = result.status ??
      (targets.length === 1
        ? "resolved"
        : targets.length > 1
          ? "ambiguous"
          : "unresolved");

    if (!validStatuses.has(status)) {
      throw new TypeError(`Invalid call resolution status: ${status}`);
    }

    reference.targetFunctionIds = targets;
    reference.status =
      targets.length === 0 ? "unresolved" : status;

    reference.resolutionReason =
      result.resolutionReason ?? null;

    return reference;
  }

  /**
   * Count an external dependency without creating a graph node for it.
   *
   * @param {string} packageName
   * @param {string} importerPath
   * @param {string} specifier
   */
  addExternalDependency(packageName, importerPath, specifier) {
    let record = this.externalDependencies.get(packageName);

    if (!record) {
      record = {
        name: packageName,
        count: 0,
        importers: new Set(),
        specifiers: new Set()
      };

      this.externalDependencies.set(packageName, record);
    }

    record.count += 1;
    record.importers.add(importerPath);
    record.specifiers.add(specifier);
  }

  /**
   * Return file-node adjacency lists.
   *
   * Forward adjacency follows import direction:
   * importer -> dependency.
   *
   * Reverse adjacency answers:
   * which files import this file?
   *
   * @param {{reverse?:boolean}} [options]
   * @returns {Map<string,string[]>}
   */
  getAdjacency({ reverse = false } = {}) {
    const adjacency = new Map();

    for (const path of this.nodes.keys()) {
      adjacency.set(path, []);
    }

    for (const edge of this.edges) {
      const from = reverse ? edge.target : edge.source;
      const to = reverse ? edge.source : edge.target;

      const neighbors = adjacency.get(from);

      if (neighbors && !neighbors.includes(to)) {
        neighbors.push(to);
      }
    }

    for (const neighbors of adjacency.values()) {
      neighbors.sort();
    }

    return adjacency;
  }

  /**
   * Return the number of distinct external packages.
   *
   * @returns {number}
   */
  get externalDependencyCount() {
    return this.externalDependencies.size;
  }

  /**
   * Count individual external import occurrences.
   *
   * @returns {number}
   */
  get externalImportCount() {
    let total = 0;

    for (const record of this.externalDependencies.values()) {
      total += record.count;
    }

    return total;
  }

  /**
   * Summarize graph structure and simple health metrics.
   *
   * @returns {object}
   */
  getStats() {
    const adjacency = this.getAdjacency();
    const reverse = this.getAdjacency({ reverse: true });
    const folderNames = new Set();
    const complexFiles = [];
    const hubs = [];
    let orphanFiles = 0;
    let parseFailures = 0;
    let parseWarnings = 0;

    for (const [path, node] of this.nodes) {
      folderNames.add(node.folder);

      const outDegree = adjacency.get(path)?.length ?? 0;
      const inDegree = reverse.get(path)?.length ?? 0;

      if (outDegree === 0 && inDegree === 0) {
        orphanFiles += 1;
      }

      if (node.parseStatus === "error") {
        parseFailures += 1;
      } else if (node.parseStatus === "recovered") {
        parseWarnings += 1;
      }

      complexFiles.push({
        path,
        loc: node.loc,
        cyclomaticComplexity: node.cyclomaticComplexity
      });

      hubs.push({
        path,
        dependencies: outDegree,
        dependents: inDegree,
        connections: outDegree + inDegree
      });
    }

    complexFiles.sort((a, b) =>
      b.cyclomaticComplexity - a.cyclomaticComplexity ||
      a.path.localeCompare(b.path)
    );

    hubs.sort((a, b) =>
      b.connections - a.connections ||
      a.path.localeCompare(b.path)
    );

    return {
      files: this.nodes.size,
      edges: this.edges.length,
      folders: folderNames.size,
      functions: this.functionNodes.size,
      calls: this.callReferences.length,
      resolvedCalls: this.callReferences.filter(
        (call) => call.status === "resolved"
      ).length,
      ambiguousCalls: this.callReferences.filter(
        (call) => call.status === "ambiguous"
      ).length,
      unresolvedCalls: this.callReferences.filter(
        (call) => call.status === "unresolved"
      ).length,
      externalDependencies: this.externalDependencyCount,
      externalImportCount: this.externalImportCount,
      unresolvedImports: this.unresolvedImports.length,
      orphanFiles,
      parseFailures,
      parseWarnings,
      mostComplexFiles: complexFiles.slice(0, 10),
      topHubs: hubs.slice(0, 10)
    };
  }

  /**
   * Convert the graph to Cytoscape-compatible elements.
   *
   * Folder nodes are created only for visualization. They are not inserted
   * into this.nodes, so graph algorithms work exclusively on file nodes.
   *
   * @param {{
   *   view?:"dependencies"|"calls",
   *   showClusters?:boolean,
   *   cycleNodes?:Set<string>|string[],
   *   blastRadius?:Set<string>|string[]
   * }} [options]
   * @returns {Array<object>}
   */
  toCytoscapeElements({
    view = "dependencies",
    showClusters = true,
    cycleNodes = new Set(),
    blastRadius = new Set()
  } = {}) {
    const cyclic = new Set(cycleNodes);
    const impacted = new Set(blastRadius);
    const elements = [];
    const folders = new Map();

    /**
     * Ensure every directory between the repository root and a file's
     * immediate parent exists as a nested Cytoscape compound node.
     *
     * For example, `packages/vite/src/index.ts` is grouped as:
     * packages -> vite -> src -> index.ts.
     * This keeps large top-level folders from expanding into hundreds of
     * simultaneous file nodes and lets users explore one directory at a time.
     *
     * @param {string} path Repository-relative file path.
     * @returns {string|undefined} ID of the deepest directory node.
     */
    const addParent = (path) => {
      if (!showClusters || !path.includes("/")) {
        return undefined;
      }

      const segments = path.split("/").filter(Boolean).slice(0, -1);
      let currentPath = "";
      let parentId;

      for (const segment of segments) {
        currentPath = currentPath
          ? `${currentPath}/${segment}`
          : segment;

        let id = folders.get(currentPath);

        if (!id) {
          id = `folder::${currentPath}`;
          folders.set(currentPath, id);

          elements.push({
            group: "nodes",
            data: {
              id,
              label: segment,
              baseLabel: segment,
              folderPath: currentPath,
              kind: "folder",
              clusterColor: getClusterColor(currentPath),
              ...(parentId ? { parent: parentId } : {})
            },
            classes: "folder-cluster"
          });
        }

        parentId = id;
      }

      return parentId;
    };

    if (view === "dependencies") {
      for (const node of this.nodes.values()) {
        const parent = addParent(node.path);
        const classes = ["file-node"];

        if (node.parseStatus === "error") {
          classes.push("parse-error");
        } else if (node.parseStatus === "recovered") {
          classes.push("parse-warning");
        }

        if (cyclic.has(node.id)) {
          classes.push("cycle-node");
        }

        if (impacted.has(node.id)) {
          classes.push("blast-radius-node");
        }

        elements.push({
          group: "nodes",
          data: {
            id: node.id,
            label: node.label,
            path: node.path,
            kind: "file",
            folder: node.folder,
            clusterColor: node.clusterColor,
            loc: node.loc,
            tokenCount: node.tokenCount,
            cyclomaticComplexity: node.cyclomaticComplexity,
            parseStatus: node.parseStatus,
            warning: node.warning,
            ...(parent ? { parent } : {})
          },
          classes: classes.join(" ")
        });
      }

      for (const edge of this.edges) {
        const classes = ["dependency-edge"];

        if (
          cyclic.has(edge.source) &&
          cyclic.has(edge.target)
        ) {
          classes.push("cycle-edge");
        }

        elements.push({
          group: "edges",
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            kind: edge.kind,
            importCount: edge.imports.length,
            lines: [...edge.lines]
          },
          classes: classes.join(" ")
        });
      }

      return elements;
    }

    if (view === "calls") {
      for (const fn of this.functionNodes.values()) {
        const parent = addParent(fn.filePath);
        const classes = ["function-node"];

        elements.push({
          group: "nodes",
          data: {
            id: fn.id,
            label: fn.name,
            kind: "function",
            filePath: fn.filePath,
            startLine: fn.startLine,
            endLine: fn.endLine,
            cyclomaticComplexity: fn.cyclomaticComplexity,
            ...(parent ? { parent } : {})
          },
          classes: classes.join(" ")
        });
      }

      for (const reference of this.callReferences) {
        // An unresolved call does not have a defensible target node.
        // It remains in callReferences and can be explained by the UI.
        for (const targetId of reference.targetFunctionIds) {
          const sourceExists = this.functionNodes.has(
            reference.sourceFunctionId
          );

          const targetExists = this.functionNodes.has(targetId);

          if (!sourceExists || !targetExists) {
            continue;
          }

          elements.push({
            group: "edges",
            data: {
              id: `${reference.id}->${targetId}`,
              source: reference.sourceFunctionId,
              target: targetId,
              kind: "call",
              status: reference.status,
              calleeName: reference.calleeName
            },
            classes: `call-edge call-${reference.status}`
          });
        }
      }

      return elements;
    }

    throw new TypeError(
      `Unsupported Cytoscape view: ${view}`
    );
  }
}
