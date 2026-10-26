/**
 * Complexity heatmap classification and summary.
 *
 * WHY:
 * Missing parser metrics must not be mistaken for low complexity.
 * The graph and its legend use the same thresholds so the colours are
 * consistent and explainable during the hackathon viva.
 */

export const COMPLEXITY_THRESHOLDS = Object.freeze({
  lowMaximum: 6,
  mediumMaximum: 14
});

/**
 * Classify a cyclomatic-complexity value.
 *
 * @param {number} complexity
 * @param {{parseStatus?:string}} [options]
 * @returns {"low"|"medium"|"high"|"unavailable"}
 */
export function getComplexityBand(
  complexity,
  { parseStatus = "ok" } = {}
) {
  if (
    parseStatus === "error" ||
    !Number.isFinite(complexity) ||
    complexity < 1
  ) {
    return "unavailable";
  }

  if (complexity <= COMPLEXITY_THRESHOLDS.lowMaximum) {
    return "low";
  }

  if (complexity <= COMPLEXITY_THRESHOLDS.mediumMaximum) {
    return "medium";
  }

  return "high";
}

/**
 * Count the complexity categories of graph file/function nodes.
 *
 * Accepts either an array or any iterable of node objects.
 * Folder clusters and non-analysis records are excluded.
 *
 * @param {Iterable<object>|Array<object>} input
 * @returns {{
 *   low:number,
 *   medium:number,
 *   high:number,
 *   unavailable:number,
 *   total:number,
 *   measured:number
 * }}
 */
export function countComplexityBands(input) {
  const counts = {
    low: 0,
    medium: 0,
    high: 0,
    unavailable: 0,
    total: 0,
    measured: 0
  };

  if (!input || typeof input[Symbol.iterator] !== "function") {
    return counts;
  }

  for (const node of input) {
    if (!node || node.kind === "folder") {
      continue;
    }

    // A FileInfo/FunctionInfo graph node is expected to have its own ID.
    if (!node.id && !node.path && !node.filePath) {
      continue;
    }

    counts.total += 1;

    const band = getComplexityBand(
      node.cyclomaticComplexity,
      { parseStatus: node.parseStatus }
    );

    counts[band] += 1;

    if (band !== "unavailable") {
      counts.measured += 1;
    }
  }

  return counts;
}