/**
 * Presentation helpers for hierarchical folder navigation in Cytoscape.
 *
 * The complete DependencyGraph remains the source of truth. This module
 * creates a smaller visible projection by collapsing directory subtrees
 * into compound folder nodes and aggregating edges across collapsed folders.
 */

/**
 * Safely convert a Cytoscape element's classes into a Set.
 *
 * @param {object} element
 * @returns {Set<string>}
 */
function getClassSet(element) {
  return new Set(
    String(element?.classes ?? "")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Determine the weight represented by one original edge.
 *
 * @param {object} edge
 * @param {"dependencies"|"calls"} view
 * @returns {number}
 */
function edgeWeight(edge, view) {
  if (view === "calls") {
    return 1;
  }

  const weight = Number(edge?.data?.importCount);

  return Number.isFinite(weight) && weight > 0
    ? weight
    : 1;
}

/**
 * Get a folder and every ancestor directory, starting with the nearest.
 * The visited set also protects this presentation layer from malformed
 * parent cycles in externally supplied element fixtures.
 *
 * @param {string|undefined} folderId
 * @param {Map<string,object>} folderDataById
 * @returns {string[]}
 */
function getFolderAncestors(folderId, folderDataById) {
  const ancestors = [];
  const seen = new Set();
  let currentId = folderId;

  while (
    currentId &&
    folderDataById.has(currentId) &&
    !seen.has(currentId)
  ) {
    seen.add(currentId);
    ancestors.push(currentId);
    currentId = folderDataById.get(currentId)?.parent;
  }

  return ancestors;
}

/**
 * Attach recursive counts to every folder node.
 *
 * Each folder summary counts all descendant files/functions and all edges
 * whose endpoints are inside that directory subtree, not just immediate
 * children. Counts are presentation-only; input elements are never mutated.
 *
 * @param {Array<object>} elements Cytoscape elements from DependencyGraph.
 * @param {"dependencies"|"calls"} view
 * @returns {Array<object>}
 */
export function prepareGraphNavigationElements(
  elements,
  view = "dependencies"
) {
  if (!Array.isArray(elements)) {
    return [];
  }

  const nodes = elements.filter(
    (element) => element?.group === "nodes"
  );
  const edges = elements.filter(
    (element) => element?.group === "edges"
  );

  const nodeById = new Map(
    nodes.map((element) => [element.data?.id, element.data])
  );

  const folderDataById = new Map();
  const folderStats = new Map();

  for (const node of nodes) {
    if (node.data?.kind !== "folder") {
      continue;
    }

    folderDataById.set(node.data.id, node.data);
    folderStats.set(node.data.id, {
      fileCount: 0,
      internalRelationshipCount: 0,
      cycleCount: 0,
      blastRadiusCount: 0
    });
  }

  for (const node of nodes) {
    const data = node.data ?? {};

    if (data.kind === "folder") {
      continue;
    }

    for (const folderId of getFolderAncestors(
      data.parent,
      folderDataById
    )) {
      const stats = folderStats.get(folderId);

      if (!stats) {
        continue;
      }

      stats.fileCount += 1;

      const classes = getClassSet(node);

      if (classes.has("cycle-node")) {
        stats.cycleCount += 1;
      }

      if (classes.has("blast-radius-node")) {
        stats.blastRadiusCount += 1;
      }
    }
  }

  for (const edge of edges) {
    const source = nodeById.get(edge.data?.source);
    const target = nodeById.get(edge.data?.target);

    if (!source || !target) {
      continue;
    }

    const sourceAncestors = getFolderAncestors(
      source.parent,
      folderDataById
    );
    const targetAncestorSet = new Set(
      getFolderAncestors(target.parent, folderDataById)
    );
    const weight = edgeWeight(edge, view);

    // An edge is internal to each directory subtree containing both ends.
    for (const folderId of sourceAncestors) {
      if (!targetAncestorSet.has(folderId)) {
        continue;
      }

      const stats = folderStats.get(folderId);

      if (stats) {
        stats.internalRelationshipCount += weight;
      }
    }
  }

  return elements.map((element) => {
    if (
      element?.group !== "nodes" ||
      element.data?.kind !== "folder"
    ) {
      return element;
    }

    const stats = folderStats.get(element.data.id) ?? {
      fileCount: 0,
      internalRelationshipCount: 0,
      cycleCount: 0,
      blastRadiusCount: 0
    };

    const folderPath = String(
      element.data.folderPath ?? element.data.baseLabel ?? element.data.label ?? ""
    );
    const folderDepth = folderPath
      ? folderPath.split("/").filter(Boolean).length
      : 1;
    const classes = getClassSet(element);

    classes.add(
      folderDepth <= 1 ? "folder-depth-root" : "folder-depth-nested"
    );

    return {
      ...element,
      classes: [...classes].join(" "),
      data: {
        ...element.data,
        baseLabel: element.data.baseLabel ?? element.data.label,
        folderPath: element.data.folderPath ?? element.data.label,
        folderDepth,
        childLabel: view === "calls" ? "functions" : "files",
        ...stats
      }
    };
  });
}

/**
 * Decide which directory clusters should initially be expanded.
 *
 * Small repositories remain fully explorable; larger repositories start
 * collapsed at the root directories and can be explored incrementally.
 *
 * @param {Array<object>} elements Prepared Cytoscape elements.
 * @param {number} analysedNodeCount Number of analysed files or functions.
 * @param {number} [threshold=80]
 * @returns {Set<string>}
 */
export function getInitialExpandedFolders(
  elements,
  analysedNodeCount,
  threshold = 80
) {
  const folderIds = (
    Array.isArray(elements) ? elements : []
  )
    .filter(
      (element) =>
        element?.group === "nodes" &&
        element.data?.kind === "folder"
    )
    .map((element) => element.data.id);

  return (
    Number.isFinite(analysedNodeCount) &&
    analysedNodeCount > threshold
  )
    ? new Set()
    : new Set(folderIds);
}

/**
 * Return the visible projection of a hierarchical graph.
 *
 * A child directory or file appears only when every ancestor directory is
 * visible and its immediate parent directory is expanded. Edges with hidden
 * endpoints are redirected to the nearest visible ancestor folder. Multiple
 * edges crossing the same visible boundary are aggregated into one edge.
 *
 * @param {Array<object>} elements Prepared Cytoscape elements.
 * @param {Set<string>} expandedFolders IDs of expanded folder clusters.
 * @param {"dependencies"|"calls"} view
 * @returns {Array<object>}
 */
export function getVisibleGraphElements(
  elements,
  expandedFolders,
  view = "dependencies"
) {
  if (!Array.isArray(elements)) {
    return [];
  }

  const expanded = expandedFolders instanceof Set
    ? expandedFolders
    : new Set();

  const nodes = elements.filter(
    (element) => element?.group === "nodes"
  );
  const edges = elements.filter(
    (element) => element?.group === "edges"
  );

  const nodeById = new Map(
    nodes.map((element) => [element.data?.id, element.data])
  );

  // Resolve visibility iteratively so even unusually deep directory trees do
  // not consume the JavaScript call stack.
  const visibility = new Map();

  function isVisible(nodeId) {
    if (visibility.has(nodeId)) {
      return visibility.get(nodeId);
    }

    const chain = [];
    const seen = new Set();
    let currentId = nodeId;
    let ancestorVisible = false;

    while (currentId && !seen.has(currentId)) {
      if (visibility.has(currentId)) {
        ancestorVisible = visibility.get(currentId);
        break;
      }

      seen.add(currentId);
      const data = nodeById.get(currentId);

      if (!data) {
        ancestorVisible = false;
        break;
      }

      if (!data.parent) {
        visibility.set(currentId, true);
        ancestorVisible = true;
        break;
      }

      chain.push({
        id: currentId,
        parentId: data.parent
      });
      currentId = data.parent;
    }

    if (currentId && seen.has(currentId) && !visibility.has(currentId)) {
      ancestorVisible = false;
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const { id, parentId } = chain[index];
      const visible = ancestorVisible && expanded.has(parentId);
      visibility.set(id, visible);
      ancestorVisible = visible;
    }

    return visibility.get(nodeId) ?? false;
  }

  const visibleNodes = nodes
    .filter((element) => isVisible(element.data?.id))
    .map((element) => {
      if (element.data?.kind !== "folder") {
        return element;
      }

      const data = element.data;
      const isExpanded = expanded.has(data.id);
      const classes = getClassSet(element);

      if (isExpanded) {
        classes.delete("folder-collapsed");
        classes.add("folder-expanded");
      } else {
        classes.delete("folder-expanded");
        classes.add("folder-collapsed");
      }

      const labelLines = [
        data.baseLabel ?? data.label ?? "Folder",
        `${data.fileCount ?? 0} ${data.childLabel ?? "files"}`,
        `${data.internalRelationshipCount ?? 0} internal ${
          view === "calls" ? "calls" : "imports"
        }`
      ];

      if ((data.cycleCount ?? 0) > 0) {
        labelLines.push(
          `${data.cycleCount} cyclic files/functions`
        );
      }

      return {
        ...element,
        data: {
          ...data,
          label: isExpanded
            ? (data.baseLabel ?? data.label)
            : labelLines.join("\n")
        },
        classes: [...classes].join(" ")
      };
    });

  const visibleIds = new Set(
    visibleNodes.map((element) => element.data.id)
  );
  const directEdges = [];
  const aggregateCounts = new Map();

  /**
   * Resolve a hidden endpoint to its nearest visible ancestor folder.
   *
   * @param {string} id Original node ID.
   * @returns {string|null}
   */
  function visibleProxy(id) {
    if (visibleIds.has(id)) {
      return id;
    }

    let data = nodeById.get(id);
    const seen = new Set();

    while (data?.parent && !seen.has(data.parent)) {
      const parentId = data.parent;
      seen.add(parentId);

      if (visibleIds.has(parentId)) {
        return parentId;
      }

      data = nodeById.get(parentId);
    }

    return null;
  }

  for (const edge of edges) {
    const sourceId = edge.data?.source;
    const targetId = edge.data?.target;

    if (
      !nodeById.has(sourceId) ||
      !nodeById.has(targetId)
    ) {
      continue;
    }

    if (visibleIds.has(sourceId) && visibleIds.has(targetId)) {
      directEdges.push(edge);
      continue;
    }

    const sourceProxy = visibleProxy(sourceId);
    const targetProxy = visibleProxy(targetId);

    if (
      !sourceProxy ||
      !targetProxy ||
      sourceProxy === targetProxy
    ) {
      // Relationships wholly inside a collapsed folder are represented in
      // that folder's internal-relationship summary, not as a self-loop.
      continue;
    }

    const key = JSON.stringify([sourceProxy, targetProxy]);
    const previous = aggregateCounts.get(key);

    if (previous) {
      previous.count += edgeWeight(edge, view);
    } else {
      aggregateCounts.set(key, {
        source: sourceProxy,
        target: targetProxy,
        count: edgeWeight(edge, view)
      });
    }
  }

  const aggregateEdges = [...aggregateCounts.values()].map(
    (aggregate) => ({
      group: "edges",
      data: {
        id: [
          "atlas-aggregate",
          encodeURIComponent(aggregate.source),
          encodeURIComponent(aggregate.target)
        ].join("::"),
        source: aggregate.source,
        target: aggregate.target,
        kind: view === "calls"
          ? "aggregate-call"
          : "aggregate-import",
        importCount: aggregate.count,
        label: aggregate.count > 1
          ? `×${aggregate.count}`
          : ""
      },
      classes: "folder-aggregate-edge"
    })
  );

  return [
    ...visibleNodes,
    ...directEdges,
    ...aggregateEdges
  ];
}
