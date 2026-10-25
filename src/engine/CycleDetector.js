/**
 * Directed cycle detection using iterative Tarjan SCC.
 *
 * WHY:
 * - Recursive DFS can overflow on deeply connected repositories.
 * - Tarjan identifies strongly connected components in O(V + E).
 * - BFS then finds one shortest directed cycle for each cyclic component.
 */

function makeAdjacency(graph) {
  if (
    !graph ||
    !(graph.nodes instanceof Map) ||
    typeof graph.getAdjacency !== "function"
  ) {
    throw new TypeError(
      "CycleDetector expects a DependencyGraph instance."
    );
  }

  return graph.getAdjacency();
}

/**
 * Find one shortest directed cycle within a strongly connected component.
 *
 * BFS is run from each component node. This extra phase is more expensive
 * than SCC detection itself; it is intentionally separated from Tarjan.
 *
 * @param {string[]} component
 * @param {Map<string,string[]>} adjacency
 * @returns {string[]|null}
 */
function findShortestCycle(component, adjacency) {
  const members = new Set(component);
  let bestPath = null;

  for (const start of component) {
    const queue = [start];
    let head = 0;

    const previous = new Map([[start, null]]);
    let foundPath = null;

    while (head < queue.length) {
      const current = queue[head++];

      // Since BFS visits vertices in nondecreasing distance, the first
      // edge back to start gives the shortest cycle beginning at start.
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!members.has(neighbor)) {
          continue;
        }

        if (neighbor === start) {
          const path = [];
          let cursor = current;

          while (cursor !== null) {
            path.push(cursor);
            cursor = previous.get(cursor) ?? null;
          }

          path.reverse();
          path.push(start);

          foundPath = path;
          break;
        }

        if (!previous.has(neighbor)) {
          previous.set(neighbor, current);
          queue.push(neighbor);
        }
      }

      if (foundPath) {
        break;
      }
    }

    if (
      foundPath &&
      (!bestPath || foundPath.length < bestPath.length)
    ) {
      bestPath = foundPath;
    }

    // A self-loop has two path entries, the same vertex at both ends.
    if (bestPath?.length === 2) {
      break;
    }
  }

  return bestPath;
}

export default class CycleDetector {
  /**
   * Find all cyclic SCCs and one shortest cycle path per component.
   *
   * @param {object} graph
   * @returns {{
   *   cycles:Array<object>,
   *   cyclicNodes:string[],
   *   cyclicEdges:Array<{source:string,target:string}>,
   *   stats:{components:number,cyclicComponents:number}
   * }}
   */
  detect(graph) {
    const adjacency = makeAdjacency(graph);

    const discoveryIndex = new Map();
    const lowLink = new Map();
    const onTarjanStack = new Set();
    const tarjanStack = [];
    const components = [];

    let nextIndex = 0;

    // Each DFS frame holds the state that a recursive call normally keeps
    // on the JavaScript call stack.
    for (const start of adjacency.keys()) {
      if (discoveryIndex.has(start)) {
        continue;
      }

      discoveryIndex.set(start, nextIndex);
      lowLink.set(start, nextIndex);
      nextIndex += 1;

      tarjanStack.push(start);
      onTarjanStack.add(start);

      const dfsStack = [{
        node: start,
        parent: null,
        nextNeighbor: 0,
        neighbors: adjacency.get(start) ?? []
      }];

      while (dfsStack.length > 0) {
        const frame = dfsStack[dfsStack.length - 1];
        const node = frame.node;

        if (frame.nextNeighbor < frame.neighbors.length) {
          const neighbor = frame.neighbors[frame.nextNeighbor];
          frame.nextNeighbor += 1;

          if (!discoveryIndex.has(neighbor)) {
            // Tree edge: initialize the child and descend iteratively.
            discoveryIndex.set(neighbor, nextIndex);
            lowLink.set(neighbor, nextIndex);
            nextIndex += 1;

            tarjanStack.push(neighbor);
            onTarjanStack.add(neighbor);

            dfsStack.push({
              node: neighbor,
              parent: node,
              nextNeighbor: 0,
              neighbors: adjacency.get(neighbor) ?? []
            });

            continue;
          }

          // A back/cross edge to a vertex still on Tarjan's stack may lower
          // this node's link value.
          if (onTarjanStack.has(neighbor)) {
            lowLink.set(
              node,
              Math.min(
                lowLink.get(node),
                discoveryIndex.get(neighbor)
              )
            );
          }

          continue;
        }

        // All outgoing neighbors have now been visited.
        dfsStack.pop();

        if (frame.parent !== null) {
          lowLink.set(
            frame.parent,
            Math.min(
              lowLink.get(frame.parent),
              lowLink.get(node)
            )
          );
        }

        if (lowLink.get(node) === discoveryIndex.get(node)) {
          const component = [];
          let member;

          do {
            member = tarjanStack.pop();
            onTarjanStack.delete(member);
            component.push(member);
          } while (member !== node);

          component.sort();
          components.push(component);
        }
      }
    }

    const cyclicComponents = components.filter((component) => {
      if (component.length > 1) {
        return true;
      }

      const onlyNode = component[0];

      return (adjacency.get(onlyNode) ?? []).includes(onlyNode);
    });

    // Stable ordering makes test output and UI cycle numbering predictable.
    cyclicComponents.sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    const cycles = cyclicComponents.map(
      (component, index) => {
        const members = new Set(component);

        const internalEdges = [];

        for (const source of component) {
          for (const target of adjacency.get(source) ?? []) {
            if (members.has(target)) {
              internalEdges.push({ source, target });
            }
          }
        }

        const shortestPath = findShortestCycle(
          component,
          adjacency
        );

        return {
          id: `cycle-${index + 1}`,
          nodes: component,
          size: component.length,
          shortestPath,
          selfLoop:
            component.length === 1 &&
            (adjacency.get(component[0]) ?? [])
              .includes(component[0]),
          edges: internalEdges
        };
      }
    );

    const cyclicNodes = [
      ...new Set(cycles.flatMap((cycle) => cycle.nodes))
    ].sort();

    const cyclicEdgeKeys = new Set();

    for (const cycle of cycles) {
      for (const edge of cycle.edges) {
        cyclicEdgeKeys.add(
          JSON.stringify([edge.source, edge.target])
        );
      }
    }

    const cyclicEdges = [];

    for (const edge of graph.edges) {
      if (
        cyclicEdgeKeys.has(
          JSON.stringify([edge.source, edge.target])
        )
      ) {
        cyclicEdges.push({
          source: edge.source,
          target: edge.target
        });
      }
    }

    return {
      cycles,
      cyclicNodes,
      cyclicEdges,
      stats: {
        components: components.length,
        cyclicComponents: cycles.length
      }
    };
  }
}