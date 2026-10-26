/**
 * Source Explorer and graph-navigation view-model helpers.
 *
 * WHY:
 * Separating graph navigation from source navigation lets the UI inspect
 * a file's relationships without automatically opening the source editor.
 * These helpers stay independent of React and are straightforward to test.
 */

/**
 * Build a source view-model for one graph file.
 *
 * @param {object} graph
 * @param {string} path
 * @returns {{
 *   file:object,
 *   imports:Array<object>,
 *   importedBy:Array<object>,
 *   functions:Array<object>,
 *   metrics:{
 *     loc:number,
 *     tokenCount:number,
 *     cyclomaticComplexity:number
 *   }
 * }|null}
 */
export function createSourceExplorerModel(graph, path) {
  if (
    !graph ||
    typeof path !== "string" ||
    !(graph.nodes instanceof Map) ||
    !(graph.functionNodes instanceof Map) ||
    !Array.isArray(graph.edges)
  ) {
    return null;
  }

  const file = graph.nodes.get(path);

  if (!file) {
    return null;
  }

  const imports = graph.edges
    .filter((edge) => edge.source === path)
    .slice()
    .sort((a, b) => a.target.localeCompare(b.target));

  const importedBy = graph.edges
    .filter((edge) => edge.target === path)
    .slice()
    .sort((a, b) => a.source.localeCompare(b.source));

  const functions = [...graph.functionNodes.values()]
    .filter((fn) => fn.filePath === path)
    .sort((a, b) => {
      const lineOrder = (a.startLine ?? 0) - (b.startLine ?? 0);

      if (lineOrder !== 0) {
        return lineOrder;
      }

      return (a.startColumn ?? 0) - (b.startColumn ?? 0);
    });

  return {
    file,
    imports,
    importedBy,
    functions,
    metrics: {
      loc: Number.isFinite(file.loc) ? file.loc : 0,
      tokenCount: Number.isFinite(file.tokenCount)
        ? file.tokenCount
        : 0,
      cyclomaticComplexity: Number.isFinite(
        file.cyclomaticComplexity
      )
        ? file.cyclomaticComplexity
        : 0
    }
  };
}

/**
 * Return a file and its one-hop import neighbourhood.
 *
 * For a selected file A, this includes:
 * - A itself
 * - Every internal file that A imports
 * - Every internal file that imports A
 *
 * It intentionally does not walk transitively through the entire graph.
 * This makes the result a local neighbourhood suitable for graph focus.
 *
 * @param {object} graph
 * @param {string} path
 * @returns {string[]}
 */
export function getFileNeighborhood(graph, path) {
  if (
    !graph ||
    typeof path !== "string" ||
    !(graph.nodes instanceof Map) ||
    !Array.isArray(graph.edges) ||
    !graph.nodes.has(path)
  ) {
    return [];
  }

  const paths = new Set([path]);

  for (const edge of graph.edges) {
    if (edge.source === path && graph.nodes.has(edge.target)) {
      paths.add(edge.target);
    }

    if (edge.target === path && graph.nodes.has(edge.source)) {
      paths.add(edge.source);
    }
  }

  return [...paths].sort((a, b) => {
    if (a === path) return -1;
    if (b === path) return 1;
    return a.localeCompare(b);
  });
}