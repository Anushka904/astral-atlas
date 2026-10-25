/**
 * Reverse-dependency impact analysis and starter-file ranking.
 *
 * WHY:
 * Changing a dependency can affect files that import it. Traversing the
 * reversed graph measures that impact without recursive call-stack usage.
 */

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Score how suitable a file's size is for a beginner's first change.
 *
 * The rule is intentionally transparent:
 * - Empty/unknown-size files are not recommended.
 * - Small files are reasonable but can be too trivial.
 * - Files between 10 and 300 LOC receive the full size score.
 * - Larger files lose points, down to a floor of 20.
 *
 * @param {number} loc
 * @returns {number}
 */
export function scoreFileSize(loc) {
  if (!Number.isFinite(loc) || loc <= 0) {
    return 0;
  }

  if (loc < 10) {
    return 20 + loc * 8;
  }

  if (loc <= 300) {
    return 100;
  }

  return Math.max(
    20,
    100 - (loc - 300) / 20
  );
}

/**
 * Convert cyclomatic complexity into a 0–100 simplicity score.
 *
 * A score of 100 corresponds to complexity 1. Complexity of 50 or above
 * receives zero points for this component.
 *
 * @param {number} complexity
 * @returns {number}
 */
export function scoreComplexity(complexity) {
  const normalized = Number.isFinite(complexity)
    ? Math.max(1, complexity)
    : 50;

  return Math.max(
    0,
    100 * (1 - (normalized - 1) / 49)
  );
}

export default class BlastRadiusAnalyzer {
  /**
   * @param {{maximumNodes?:number}} [options]
   */
  constructor({
    maximumNodes = 2000
  } = {}) {
    this.maximumNodes = maximumNodes;
  }

  /**
   * Find all files transitively importing the selected file.
   *
   * The starting file is excluded from blastRadius.
   *
   * @param {object} graph
   * @param {string} startPath
   * @returns {{
   *   start:string,
   *   blastRadius:number,
   *   impacted:Array<{path:string,distance:number}>,
   *   maxDepth:number
   * }}
   */
  analyze(graph, startPath) {
    if (!graph || !(graph.nodes instanceof Map)) {
      throw new TypeError(
        "BlastRadiusAnalyzer expects a DependencyGraph."
      );
    }

    if (!graph.nodes.has(startPath)) {
      throw new Error(
        `Cannot analyse blast radius: unknown file "${startPath}".`
      );
    }

    if (graph.nodes.size > this.maximumNodes) {
      // The BFS itself is linear, but we guard against accidentally
      // running many independent analyses over an oversized graph.
      // The caller can explicitly raise the limit when appropriate.
      throw new RangeError(
        `This graph has ${graph.nodes.size} nodes, exceeding the configured limit of ${this.maximumNodes}.`
      );
    }

    const reverseAdjacency = graph.getAdjacency({
      reverse: true
    });

    const distance = new Map([[startPath, 0]]);
    const queue = [startPath];

    let head = 0;
    let maxDepth = 0;

    while (head < queue.length) {
      const current = queue[head++];
      const nextDistance = distance.get(current) + 1;

      for (const importer of reverseAdjacency.get(current) ?? []) {
        if (distance.has(importer)) {
          continue;
        }

        distance.set(importer, nextDistance);
        queue.push(importer);

        maxDepth = Math.max(
          maxDepth,
          nextDistance
        );
      }
    }

    const impacted = [...distance.entries()]
      .filter(([path]) => path !== startPath)
      .map(([path, depth]) => ({
        path,
        distance: depth
      }))
      .sort((a, b) =>
        a.distance - b.distance ||
        a.path.localeCompare(b.path)
      );

    return {
      start: startPath,
      blastRadius: impacted.length,
      impacted,
      maxDepth
    };
  }

  /**
   * Rank files as potential good-first-change starting points.
   *
   * Formula:
   *   45% low blast radius
   *   35% low cyclomatic complexity
   *   20% reasonable file size
   *
   * The returned score breakdown makes the recommendation explainable.
   * Files with parse failures or zero LOC are omitted because their metrics
   * are not reliable enough to rank confidently.
   *
   * @param {object} graph
   * @param {{limit?:number}} [options]
   * @returns {Array<object>}
   */
  rankStarterFiles(graph, {
    limit = 10
  } = {}) {
    if (!graph || !(graph.nodes instanceof Map)) {
      throw new TypeError(
        "Starter-file ranking expects a DependencyGraph."
      );
    }

    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError(
        "Starter-file limit must be a non-negative integer."
      );
    }

    const totalNodes = graph.nodes.size;

    if (totalNodes === 0 || limit === 0) {
      return [];
    }

    const reverseAdjacency = graph.getAdjacency({
      reverse: true
    });

    const rankings = [];

    for (const [path, node] of graph.nodes) {
      if (
        node.parseStatus === "error" ||
        !Number.isFinite(node.loc) ||
        node.loc <= 0
      ) {
        continue;
      }

      // BFS from each candidate computes its transitive set of dependents.
      // The total cost is O(V * (V + E)) in the worst case, which is
      // acceptable for small ranking panels but should be benchmarked on
      // large repositories.
      const visited = new Set([path]);
      const queue = [path];

      let head = 0;

      while (head < queue.length) {
        const current = queue[head++];

        for (
          const importer of reverseAdjacency.get(current) ?? []
        ) {
          if (visited.has(importer)) {
            continue;
          }

          visited.add(importer);
          queue.push(importer);
        }
      }

      const blastRadius = visited.size - 1;

      const blastRadiusScore =
        100 * (
          1 -
          blastRadius / Math.max(1, totalNodes - 1)
        );

      const complexityScore = scoreComplexity(
        node.cyclomaticComplexity
      );

      const sizeScore = scoreFileSize(node.loc);

      const score =
        0.45 * blastRadiusScore +
        0.35 * complexityScore +
        0.20 * sizeScore;

      rankings.push({
        path,
        score: roundScore(score),
        blastRadius,
        loc: node.loc,
        cyclomaticComplexity:
          node.cyclomaticComplexity,
        breakdown: {
          blastRadiusScore: roundScore(blastRadiusScore),
          complexityScore: roundScore(complexityScore),
          sizeScore: roundScore(sizeScore),
          weights: {
            blastRadius: 0.45,
            complexity: 0.35,
            size: 0.20
          }
        },
        explanation:
          `Impact ${roundScore(blastRadiusScore)}/100; ` +
          `simplicity ${roundScore(complexityScore)}/100; ` +
          `size suitability ${roundScore(sizeScore)}/100.`
      });
    }

    rankings.sort((a, b) =>
      b.score - a.score ||
      a.blastRadius - b.blastRadius ||
      a.path.localeCompare(b.path)
    );

    return rankings.slice(0, limit);
  }
}