/**
 * Interactive dependency atlas for Astral Atlas.
 *
 * Uses:
 * - Cytoscape with fCoSE and Dagre layouts.
 * - Green folder colours.
 * - Low-detail labels for dense graphs.
 * - Hover details and selected-node labels.
 * - A visible, measurable complexity heatmap.
 * - Collapsible compound folder clusters.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";

import cytoscape from "cytoscape";
import fcoseModule from "cytoscape-fcose";
import dagreModule from "cytoscape-dagre";

import {
  getComplexityBand,
  countComplexityBands
} from "../engine/ComplexityScale.js";

const fcose = fcoseModule.default ?? fcoseModule;
const dagre = dagreModule.default ?? dagreModule;

let extensionsRegistered = false;

const GREEN_CLUSTERS = [
  "#2A835F",
  "#66BB6A",
  "#8BBB92",
  "#A5D6A7",
  "#4E9977",
  "#3D7A65",
  "#B5D7BC",
  "#4C9B8A",
  "#6FAD99",
  "#28776D",
  "#9CC9AC",
  "#D4E8D4"
];

const C = {
  background: "#092328",
  panel: "#0D3434",
  raised: "#12544F",
  border: "#28574F",
  text: "#E8F5E9",
  muted: "#A5D6A7",
  accent: "#66BB6A",
  sage: "#8BBB92",
  forest: "#2A835F",
  warning: "#D17C72"
};

function registerExtensions() {
  if (extensionsRegistered) {
    return;
  }

  cytoscape.use(fcose);
  cytoscape.use(dagre);
  extensionsRegistered = true;
}

/**
 * Stable folder colour derived from the folder name.
 *
 * @param {string} name
 * @returns {string}
 */
function folderColor(name) {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }

  return GREEN_CLUSTERS[
    Math.abs(hash) % GREEN_CLUSTERS.length
  ];
}

/**
 * Recolour visualization elements without changing the underlying graph.
 *
 * @param {Array<object>} elements
 * @returns {Array<object>}
 */
function recolourElements(elements) {
  return elements.map((element) => {
    if (element.group !== "nodes") {
      return element;
    }

    const data = element.data;

    const key = data.kind === "folder"
      ? data.label
      : data.folder ?? data.filePath ?? data.path ?? data.id;

    return {
      ...element,
      data: {
        ...data,
        clusterColor: folderColor(String(key))
      }
    };
  });
}

/**
 * Zoom threshold at which labels become visible.
 *
 * @param {number} count
 * @returns {number}
 */
function labelThreshold(count) {
  if (count > 1000) return 1.55;
  if (count > 500) return 1.4;
  if (count > 120) return 1.18;
  return 0.92;
}

/**
 * Apply the current folder expansion state to graph elements.
 *
 * @param {Array<object>} elements
 * @param {Set<string>} expandedFolders
 * @returns {Array<object>}
 */
function visibleElements(elements, expandedFolders) {
  const nodes = elements.filter(
    (element) => element.group === "nodes"
  );

  const visibleIds = new Set(
    nodes
      .filter((element) => element.data.kind === "folder")
      .map((element) => element.data.id)
  );

  for (const element of nodes) {
    const data = element.data;

    if (data.kind === "folder") continue;

    if (!data.parent || expandedFolders.has(data.parent)) {
      visibleIds.add(data.id);
    }
  }

  return elements.filter((element) => {
    if (element.group === "nodes") {
      return visibleIds.has(element.data.id);
    }

    if (element.group === "edges") {
      return (
        visibleIds.has(element.data.source) &&
        visibleIds.has(element.data.target)
      );
    }

    return false;
  });
}

/**
 * Apply a complexity category to every currently visible file/function node.
 *
 * @param {object} cy
 * @param {boolean} enabled
 */
function applyHeatmap(cy, enabled) {
  const nodes = cy.nodes(
    '[kind = "file"], [kind = "function"]'
  );

  nodes.removeClass(
    "heat-low heat-medium heat-high heat-unavailable"
  );

  if (!enabled) return;

  cy.batch(() => {
    nodes.forEach((node) => {
      const band = getComplexityBand(
        Number(node.data("cyclomaticComplexity")),
        {
          parseStatus: node.data("parseStatus") ?? "ok"
        }
      );

      node.addClass(`heat-${band}`);
    });
  });
}

/**
 * Create Cytoscape style rules.
 *
 * @param {{largeGraph:boolean}} options
 * @returns {Array<object>}
 */
function createStyles({ largeGraph }) {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        color: C.text,
        "font-family": "Manrope, sans-serif",
        "font-size": 10,
        "font-weight": 600,
        "text-wrap": "ellipsis",
        "text-max-width": 110,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 7,
        "text-outline-width": 2,
        "text-outline-color": C.background,
        "text-outline-opacity": 0.92,
        "overlay-opacity": 0
      }
    },
    {
      selector: "node.labels-hidden",
      style: { label: "" }
    },
    {
      selector: 'node[kind = "file"]',
      style: {
        shape: "ellipse",
        width: "mapData(loc, 0, 300, 20, 43)",
        height: "mapData(loc, 0, 300, 20, 43)",
        "background-color": "data(clusterColor)",
        "background-opacity": 0.96,
        "border-color": "data(clusterColor)",
        "border-width": 1.5,
        "border-opacity": 0.95
      }
    },
    {
      selector: 'node[kind = "function"]',
      style: {
        shape: "round-rectangle",
        width: 34,
        height: 23,
        padding: "4px",
        "background-color": C.forest,
        "border-color": C.sage,
        "border-width": 1.2,
        "text-valign": "center",
        "text-margin-y": 0
      }
    },
    {
      selector: 'node[kind = "folder"]',
      style: {
        shape: "round-rectangle",
        label: "data(label)",
        "background-color": "data(clusterColor)",
        "background-opacity": 0.12,
        "border-color": "data(clusterColor)",
        "border-opacity": 0.9,
        "border-width": 1.4,
        color: C.text,
        "font-size": 12,
        "font-weight": 700,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 7,
        padding: "28px",
        "min-width": 70,
        "min-height": 50
      }
    },
    {
      selector: ".parse-error",
      style: {
        shape: "diamond",
        "border-color": C.warning,
        "border-width": 3.5,
        "background-color": "#173B3A"
      }
    },
    {
      selector: ".parse-warning",
      style: {
        "border-color": C.sage,
        "border-width": 3,
        "border-style": "dashed"
      }
    },
    {
      selector: ".cycle-node",
      style: {
        "border-color": C.accent,
        "border-width": 4,
        "border-opacity": 1
      }
    },
    {
      selector: ".blast-radius-node",
      style: {
        "border-color": C.sage,
        "border-width": 3,
        "border-style": "dashed",
        "border-opacity": 1
      }
    },
    {
      selector: ".heat-low",
      style: {
        "background-color": C.sage,
        "border-color": C.text,
        "border-width": 1.5
      }
    },
    {
      selector: ".heat-medium",
      style: {
        "background-color": C.accent,
        "border-color": C.text,
        "border-width": 2
      }
    },
    {
      selector: ".heat-high",
      style: {
        "background-color": C.forest,
        "border-color": C.text,
        "border-width": 3.5
      }
    },
    {
      selector: ".heat-unavailable",
      style: {
        "background-color": "#173B3A",
        "border-color": C.sage,
        "border-width": 2.5,
        "border-style": "dashed"
      }
    },
    {
      selector: "edge",
      style: {
        width: largeGraph ? 0.7 : 1.1,
        "line-color": "#4A776A",
        "target-arrow-color": C.sage,
        "target-arrow-shape": "triangle",
        "arrow-scale": largeGraph ? 0.55 : 0.7,
        "curve-style": largeGraph ? "haystack" : "bezier",
        opacity: largeGraph ? 0.48 : 0.72,
        "overlay-opacity": 0
      }
    },
    {
      selector: ".cycle-edge",
      style: {
        "line-color": C.accent,
        "target-arrow-color": C.accent,
        width: 2.4,
        opacity: 1
      }
    },
    {
      selector: ".call-edge",
      style: {
        "line-color": C.sage,
        "target-arrow-color": C.sage,
        "line-style": "dashed",
        width: 1.3,
        opacity: 0.9
      }
    },
    {
      selector: "node:selected",
      style: {
        label: "data(label)",
        "border-color": C.text,
        "border-width": 3.5,
        "shadow-blur": 20,
        "shadow-color": C.accent,
        "shadow-opacity": 0.9,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
        "z-index": 999,
        "text-background-color": C.panel,
        "text-background-opacity": 0.96,
        "text-background-padding": 4,
        "text-outline-opacity": 0
      }
    }
  ];
}

function createLayoutOptions(layout, count, reducedMotion) {
  if (layout === "dagre") {
    return {
      name: "dagre",
      rankDir: "LR",
      nodeSep: count <= 60 ? 55 : 80,
      rankSep: count <= 60 ? 110 : 145,
      edgeSep: 18,
      fit: true,
      padding: 55,
      animate: false
    };
  }

  return {
    name: "fcose",
    quality: count > 500 ? "draft" : "default",
    randomize: true,
    animate: count <= 60 && !reducedMotion,
    animationDuration: count <= 60 && !reducedMotion ? 300 : 0,
    fit: true,
    padding: 55,
    nodeDimensionsIncludeLabels: count <= 60,
    nodeRepulsion: count > 500
      ? 26000
      : count > 120
        ? 18000
        : 10000,
    idealEdgeLength: count > 500
      ? 145
      : count > 120
        ? 125
        : 105,
    edgeElasticity: 0.35,
    nestingFactor: 0.12,
    gravity: 0.12,
    numIter: count > 500
      ? 1800
      : count <= 250
        ? 3000
        : 2200,
    tile: true,
    packComponents: true
  };
}

function nodeCountLabel(view, graph) {
  const count = view === "calls"
    ? graph.functionNodes.size
    : graph.nodes.size;

  return `${count.toLocaleString()} ${
    view === "calls" ? "functions" : "files"
  }`;
}

const AtlasGraph = forwardRef(function AtlasGraph({
  graph,
  layout = "fcose",
  view = "dependencies",
  cycleNodes = [],
  blastRadiusPaths = [],
  heatmap = false,
  onSelectFile,
  onLayoutComplete,
  onFps
}, ref) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const helperRef = useRef(null);

  const onSelectRef = useRef(onSelectFile);
  const onLayoutRef = useRef(onLayoutComplete);
  const onFpsRef = useRef(onFps);

  const [tooltip, setTooltip] = useState(null);

  onSelectRef.current = onSelectFile;
  onLayoutRef.current = onLayoutComplete;
  onFpsRef.current = onFps;

  const cycleKey = cycleNodes.join("\u0000");
  const blastKey = blastRadiusPaths.join("\u0000");

  const allElements = useMemo(
    () => recolourElements(
      graph.toCytoscapeElements({
        view,
        showClusters: true,
        cycleNodes,
        blastRadius: blastRadiusPaths
      })
    ),
    [graph, view, cycleKey, blastKey]
  );

  const complexitySummary = useMemo(
    () => countComplexityBands(
      view === "calls"
        ? graph.functionNodes.values()
        : graph.nodes.values()
    ),
    [graph, view]
  );

  useImperativeHandle(ref, () => ({
    fit() {
      helperRef.current?.fit();
    },

    focusPaths(paths) {
      helperRef.current?.focusPaths(paths);
    }
  }), []);

  useEffect(() => {
    if (!containerRef.current || !graph) {
      return undefined;
    }

    registerExtensions();

    const count = view === "calls"
      ? graph.functionNodes.size
      : graph.nodes.size;

    const largeGraph = count > 500;

    const folders = new Set(
      allElements
        .filter(
          (element) =>
            element.group === "nodes" &&
            element.data.kind === "folder"
        )
        .map((element) => element.data.id)
    );

    const expandedFolders = count > 1500
      ? new Set()
      : new Set(folders);

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const cy = cytoscape({
      container: containerRef.current,
      elements: visibleElements(
        allElements,
        expandedFolders
      ),
      style: createStyles({ largeGraph }),
      layout: { name: "preset" },
      minZoom: 0.06,
      maxZoom: 4,
      wheelSensitivity: 0.16,
      hideEdgesOnViewport: count > 120,
      textureOnViewport: count > 120,
      motionBlur: false,
      pixelRatio: "auto",
      selectionType: "single"
    });

    cyRef.current = cy;

    let labelsHidden = null;

    function updateLabelDensity() {
      const hide =
        count > 45 &&
        cy.zoom() < labelThreshold(count);

      // Query the current collection each time: folder expansion can replace
      // all graph nodes, so retaining an earlier collection would be stale.
      const currentNodes = cy.nodes(
        '[kind = "file"], [kind = "function"]'
      );

      cy.batch(() => {
        currentNodes.forEach((node) => {
          if (hide && !node.hasClass("labels-hidden")) {
            node.addClass("labels-hidden");
          } else if (!hide && node.hasClass("labels-hidden")) {
            node.removeClass("labels-hidden");
          }
        });
      });

      labelsHidden = hide;
    }

    function refreshVisibleElements() {
      const nextElements = visibleElements(
        allElements,
        expandedFolders
      );

      cy.batch(() => {
        cy.elements().remove();
        cy.add(nextElements);
      });

      applyHeatmap(cy, heatmap);
      updateLabelDensity();
    }

    function runLayout() {
      if (cy.destroyed()) return;

      const start = performance.now();
      const options = createLayoutOptions(
        layout,
        cy.nodes().length,
        reducedMotion
      );

      const finish = () => {
        updateLabelDensity();
        onLayoutRef.current?.(performance.now() - start);
      };

      try {
        const nextLayout = cy.layout(options);
        nextLayout.one("layoutstop", finish);
        nextLayout.run();
      } catch (error) {
        console.warn(
          `Layout ${layout} failed; using Cytoscape's built-in COSE layout.`,
          error
        );

        const fallback = cy.layout({
          name: "cose",
          animate: false,
          fit: true,
          padding: 55,
          nodeRepulsion: 16000,
          idealEdgeLength: 120
        });

        fallback.one("layoutstop", finish);
        fallback.run();
      }
    }

    function focusPaths(paths) {
      const requested = new Set(paths ?? []);

      for (const element of allElements) {
        if (element.group !== "nodes") continue;

        const data = element.data;

        if (
          data.kind !== "folder" &&
          data.parent &&
          (
            requested.has(data.path) ||
            requested.has(data.filePath) ||
            requested.has(data.id)
          )
        ) {
          expandedFolders.add(data.parent);
        }
      }

      refreshVisibleElements();

      const targets = cy.nodes().filter((node) => {
        const data = node.data();

        return (
          requested.has(data.path) ||
          requested.has(data.filePath) ||
          requested.has(data.id)
        );
      });

      if (targets.length > 0) {
        cy.nodes().unselect();
        targets.select();
        cy.fit(targets, 85);
        updateLabelDensity();
      }

      setTooltip(null);
    }

    cy.on("tap", 'node[kind = "file"]', (event) => {
      const path = event.target.data("path");
      if (path) onSelectRef.current?.(path);
    });

    cy.on("tap", 'node[kind = "function"]', (event) => {
      const path = event.target.data("filePath");
      if (path) onSelectRef.current?.(path);
    });

    cy.on("dbltap", 'node[kind = "folder"]', (event) => {
      const id = event.target.id();

      if (expandedFolders.has(id)) {
        expandedFolders.delete(id);
      } else {
        expandedFolders.add(id);
      }

      refreshVisibleElements();
      runLayout();
    });

    cy.on("mouseover", "node", (event) => {
      const node = event.target;
      const data = node.data();
      const position = node.renderedPosition();

      setTooltip({
        title: data.label ?? data.id,
        path: data.path ?? data.filePath ?? null,
        kind: data.kind,
        complexity: data.cyclomaticComplexity ?? null,
        loc: data.loc ?? null,
        parseStatus: data.parseStatus ?? null,
        x: position.x,
        y: position.y
      });
    });

    cy.on("mouseout", "node", () => setTooltip(null));
    cy.on("zoom", updateLabelDensity);

    helperRef.current = {
      fit() {
        cy.fit(undefined, 55);
        updateLabelDensity();
      },
      focusPaths
    };

    applyHeatmap(cy, heatmap);

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (!cy.destroyed()) cy.resize();
          })
        : null;

    resizeObserver?.observe(containerRef.current);

    runLayout();

    return () => {
      resizeObserver?.disconnect();
      helperRef.current = null;
      setTooltip(null);
      cy.destroy();

      if (cyRef.current === cy) {
        cyRef.current = null;
      }
    };
  }, [graph, allElements, layout, view]);

  // Turning the heatmap on or off updates classes only; it doesn't recreate
  // the graph or recalculate the layout.
  useEffect(() => {
    const cy = cyRef.current;

    if (cy && !cy.destroyed()) {
      applyHeatmap(cy, heatmap);
    }
  }, [heatmap]);

  useEffect(() => {
    let frameId = 0;
    let frames = 0;
    let start = performance.now();
    let active = true;

    function tick(time) {
      if (!active) return;

      if (document.visibilityState === "hidden") {
        frames = 0;
        start = time;
      } else {
        frames += 1;
        const elapsed = time - start;

        if (elapsed >= 1000) {
          onFpsRef.current?.(frames * 1000 / elapsed);
          frames = 0;
          start = time;
        }
      }

      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      active = false;
      cancelAnimationFrame(frameId);
    };
  }, []);

  const showHeatmapLegend =
    heatmap && complexitySummary.total > 0;

  return (
    <div className="aa-graph-shell">
      <div
        className="aa-graph-canvas"
        ref={containerRef}
      />

      <div className="aa-graph-overlay aa-graph-overlay-top">
        <span className="aa-graph-status">
          {view === "calls" ? "FUNCTION CALLS" : "FILE DEPENDENCIES"}
        </span>

        <span className="aa-graph-status">
          {nodeCountLabel(view, graph)}
        </span>
      </div>

      {showHeatmapLegend && (
        <section
          className="aa-heatmap-legend"
          aria-label="Complexity heatmap legend"
          aria-live="polite"
        >
          <strong>COMPLEXITY HEATMAP</strong>

          <div>
            <i className="aa-heat-low-dot" />
            <span>Low · 1–6</span>
            <b>{complexitySummary.low}</b>
          </div>

          <div>
            <i className="aa-heat-medium-dot" />
            <span>Medium · 7–14</span>
            <b>{complexitySummary.medium}</b>
          </div>

          <div>
            <i className="aa-heat-high-dot" />
            <span>High · 15+</span>
            <b>{complexitySummary.high}</b>
          </div>

          <div>
            <i className="aa-heat-unavailable-dot" />
            <span>Unavailable</span>
            <b>{complexitySummary.unavailable}</b>
          </div>

          <p>
            Complexity colours apply to files or functions, not folder
            clusters. Unavailable means a reliable complexity score was
            not extracted.
          </p>
        </section>
      )}

      {tooltip && (
        <div
          className="aa-node-tooltip"
          role="status"
          style={{
            left: `${Math.max(
              8,
              Math.min(
                tooltip.x + 12,
                (containerRef.current?.clientWidth ?? 300) - 240
              )
            )}px`,
            top: `${Math.max(44, tooltip.y + 12)}px`
          }}
        >
          <strong>{tooltip.title}</strong>

          {tooltip.path && <span>{tooltip.path}</span>}

          {tooltip.loc !== null && tooltip.loc !== undefined && (
            <span>{tooltip.loc} lines</span>
          )}

          {tooltip.complexity !== null &&
            tooltip.complexity !== undefined && (
              <span>Complexity {tooltip.complexity}</span>
            )}

          {tooltip.parseStatus === "error" && (
            <span>Parsing failed</span>
          )}
        </div>
      )}

      <div
        className="aa-graph-controls"
        aria-label="Graph zoom controls"
      >
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => {
            const cy = cyRef.current;

            if (cy) {
              cy.zoom({
                level: Math.min(4, cy.zoom() * 1.25),
                renderedPosition: {
                  x: containerRef.current.clientWidth / 2,
                  y: containerRef.current.clientHeight / 2
                }
              });
            }
          }}
        >
          +
        </button>

        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => {
            const cy = cyRef.current;

            if (cy) {
              cy.zoom({
                level: Math.max(0.06, cy.zoom() / 1.25),
                renderedPosition: {
                  x: containerRef.current.clientWidth / 2,
                  y: containerRef.current.clientHeight / 2
                }
              });
            }
          }}
        >
          −
        </button>

        <button
          type="button"
          aria-label="Fit graph to screen"
          title="Fit graph to screen"
          onClick={() => helperRef.current?.fit()}
        >
          Fit
        </button>
      </div>

      <p className="aa-graph-help">
        Drag to pan · Scroll to zoom · Hover for details · Double-click a
        folder to expand or collapse
      </p>
    </div>
  );
});

export default AtlasGraph;