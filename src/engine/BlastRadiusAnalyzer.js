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
 * Score how suitable a file's size is for a first change.
 *
 * The score peaks around 80 LOC and changes continuously instead of giving
 * every file from 10 through 300 LOC the same perfect score. Very small
 * files may be trivial; larger files receive progressively fewer points.
 * This is an explainable heuristic, not a prediction of defect risk.
 *
 * @param {number} loc
 * @returns {number}
 */
export function scoreFileSize(loc) {
  if (!Number.isFinite(loc) || loc <= 0) {
    return 0;
  }

  if (loc < 10) {
    return 75 * (loc / 10);
  }

  if (loc <= 80) {
    return 75 + ((loc - 10) / 70) * 25;
  }

  if (loc <= 150) {
    return 100 - ((loc - 80) / 70) * 10;
  }

  if (loc <= 300) {
    return 90 - ((loc - 150) / 150) * 15;
  }

  return Math.max(20, 75 - (loc - 300) * 0.035);
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
   *   40% low blast radius
   *   30% low cyclomatic complexity
   *   20% reasonable file size
   *   10% useful connection to the internal repository graph
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

    const adjacency = graph.getAdjacency();
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
      const dependencyCount = adjacency.get(path)?.length ?? 0;
      const dependentCount = reverseAdjacency.get(path)?.length ?? 0;
      const connectionCount = dependencyCount + dependentCount;

      // An isolated file may be an intentional entry point, test, or truly
      // disconnected module. Do not automatically rank it as a perfect
      // starting point merely because its measured blast radius is zero.
      const connectivityScore = connectionCount === 0
        ? 35
        : Math.min(100, 35 + (65 * Math.min(connectionCount, 3)) / 3);

      const score =
        0.40 * blastRadiusScore +
        0.30 * complexityScore +
        0.20 * sizeScore +
        0.10 * connectivityScore;

      rankings.push({
        path,
        score: roundScore(score),
        blastRadius,
        loc: node.loc,
        cyclomaticComplexity: node.cyclomaticComplexity,
        dependencyCount,
        dependentCount,
        connectionCount,
        breakdown: {
          blastRadiusScore: roundScore(blastRadiusScore),
          complexityScore: roundScore(complexityScore),
          sizeScore: roundScore(sizeScore),
          connectivityScore: roundScore(connectivityScore),
          weights: {
            blastRadius: 0.40,
            complexity: 0.30,
            size: 0.20,
            connectivity: 0.10
          }
        },
        explanation:
          `Low-impact suitability ${roundScore(blastRadiusScore)}/100; ` +
          `simplicity ${roundScore(complexityScore)}/100; ` +
          `size suitability ${roundScore(sizeScore)}/100; ` +
          `repository connection ${roundScore(connectivityScore)}/100 ` +
          `(${connectionCount} resolved internal connection${
            connectionCount === 1 ? "" : "s"
          }).`
      });
    }

    rankings.sort((a, b) =>
      b.score - a.score ||
      a.blastRadius - b.blastRadius ||
      b.breakdown.connectivityScore - a.breakdown.connectivityScore ||
      a.loc - b.loc ||
      a.path.localeCompare(b.path)
    );

    return rankings.slice(0, limit);
  }
}
