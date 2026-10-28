/**
 * Astral Atlas — interactive dependency atlas.
 *
 * Features:
 * - Cytoscape force-directed and hierarchical layouts.
 * - Collapsed folder clusters with aggregated dependency relationships.
 * - File/function highlighting for cycles and blast radius.
 * - Complexity heatmap without a layout restart.
 * - An expanded, viewport-sized graph mode for focused exploration.
 * - Explicit fit/zoom controls and Escape-to-exit.
 *
 * The original DependencyGraph remains the source of truth.
 * Folder summaries and aggregate edges are visualisation-only elements.
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

import {
  prepareGraphNavigationElements,
  getInitialExpandedFolders,
  getVisibleGraphElements
} from "../engine/GraphNavigationModel.js";

import "../styles/atlas-graph-ux.css";

const fcose = fcoseModule.default ?? fcoseModule;
const dagre = dagreModule.default ?? dagreModule;

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const COLLAPSE_THRESHOLD = 80;

const TECH_CLUSTERS = [
  "#A78BFA",
  "#67E8F9",
  "#F472B6",
  "#FB7185",
  "#818CF8",
  "#C4B5FD",
  "#F0ABFC",
  "#60A5FA",
  "#2DD4BF",
  "#FDBA74",
  "#D8B4FE",
  "#F9A8D4"
];

const C = {
  background: "#0B0D12",
  panel: "#121622",
  raised: "#1B2030",
  border: "#30384E",
  text: "#F1F2FA",
  muted: "#B7BED0",

  violet: "#A78BFA",
  violetStrong: "#8B5CF6",
  cyan: "#67E8F9",
  rose: "#F472B6",
  coral: "#FB7185",
  warning: "#FBBF24",
  success: "#34D399"
};

let extensionsRegistered = false;

/**
 * Return a deterministic colour for a repository folder/file group.
 *
 * @param {string} name
 * @returns {string}
 */
function folderColor(name) {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }

  return TECH_CLUSTERS[
    Math.abs(hash) % TECH_CLUSTERS.length
  ];
}

/**
 * Register the layout extensions only once.
 */
function registerExtensions() {
  if (extensionsRegistered) {
    return;
  }

  cytoscape.use(fcose);
  cytoscape.use(dagre);

  extensionsRegistered = true;
}

/**
 * Recolour visualisation elements without mutating the original model.
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
      ? data.folderPath ?? data.label
      : data.folder ?? data.filePath ?? data.path ?? data.id;

    // These classes are presentation-only: the dependency graph is unchanged.
    // They let the renderer suppress hundreds of nested compound boxes on
    // large repositories while retaining top-level directory context.
    const classes = new Set(
      String(element.classes ?? "")
        .split(/\s+/)
        .filter(Boolean)
    );
    const folderPath = String(data.folderPath ?? data.label ?? "");
    const folderDepth = folderPath
      ? folderPath.split("/").filter(Boolean).length
      : 1;

    if (data.kind === "folder") {
      classes.add(
        folderDepth <= 1 ? "folder-depth-root" : "folder-depth-nested"
      );
    }

    return {
      ...element,
      classes: [...classes].join(" "),
      data: {
        ...data,
        ...(data.kind === "folder" ? { folderDepth } : {}),
        clusterColor: folderColor(String(key))
      }
    };
  });
}

/**
 * Select label visibility according to the currently visible node count.
 *
 * @param {number} count
 * @returns {number}
 */
function labelThreshold(count) {
  if (count > 1000) return 1.45;
  if (count > 500) return 1.3;
  if (count > 150) return 1.05;
  if (count > 45) return 0.8;

  return 0.3;
}

/**
 * Create Cytoscape styles using the graphite/violet theme.
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
        "text-wrap": "wrap",
        "text-max-width": 115,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 7,
        "text-outline-width": 2,
        "text-outline-color": C.background,
        "text-outline-opacity": 0.96,
        "overlay-opacity": 0
      }
    },
    {
      selector: "node.labels-hidden",
      style: {
        label: ""
      }
    },
    {
      selector: 'node[kind = "file"]',
      style: {
        shape: "ellipse",
        // Smaller marks retain useful size variation but collide less often
        // when a repository contains hundreds or thousands of files.
        width: largeGraph
          ? "mapData(loc, 0, 300, 9, 22)"
          : "mapData(loc, 0, 300, 20, 43)",
        height: largeGraph
          ? "mapData(loc, 0, 300, 9, 22)"
          : "mapData(loc, 0, 300, 20, 43)",
        "background-color": "data(clusterColor)",
        "background-opacity": 0.95,
        "border-color": "data(clusterColor)",
        "border-width": largeGraph ? 1 : 1.4,
        "border-opacity": 0.95
      }
    },
    {
      selector: 'node[kind = "function"]',
      style: {
        shape: "round-rectangle",
        width: 38,
        height: 25,
        padding: "4px",
        "background-color": C.violetStrong,
        "border-color": C.cyan,
        "border-width": 1.3,
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": 0,
        "font-size": 9
      }
    },
    {
      selector: 'node[kind = "folder"]',
      style: {
        shape: "round-rectangle",
        label: "data(label)",
        "background-color": "data(clusterColor)",
        "background-opacity": 0.15,
        "border-color": "data(clusterColor)",
        "border-opacity": 0.96,
        "border-width": 1.5,
        color: C.text,
        "font-size": 11,
        "font-weight": 700,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 7,
        padding: "28px"
      }
    },
    {
      selector: "node.folder-collapsed",
      style: {
        width: 182,
        height: 100,
        padding: "9px",
        "background-opacity": 0.25,
        "border-width": 2,
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": 0,
        "font-size": 10,
        "text-max-width": 164,
        "text-wrap": "wrap"
      }
    },
    {
      // Expanded folders remain compound parents, but faint styling prevents
      // every nested directory from painting a competing filled rectangle.
      selector: 'node[kind = "folder"].folder-expanded',
      style: {
        "background-opacity": largeGraph ? 0.015 : 0.12,
        "border-opacity": largeGraph ? 0.12 : 0.78,
        "border-width": largeGraph ? 0.7 : 1.3,
        padding: largeGraph ? "4px" : "24px"
      }
    },
    {
      // Retain only top-level cluster boundaries on very large graphs.
      selector: 'node[kind = "folder"].folder-expanded.folder-depth-root',
      style: {
        label: "data(label)",
        "background-opacity": largeGraph ? 0.055 : 0.14,
        "border-opacity": largeGraph ? 0.62 : 0.96,
        "border-width": largeGraph ? 1.5 : 1.8,
        "font-size": 11,
        padding: largeGraph ? "14px" : "28px"
      }
    },
    {
      // Nested labels and borders compete with one another when all folders
      // are expanded. Preserve their real nodes/edges; simplify only painting.
      selector: 'node[kind = "folder"].folder-expanded.folder-depth-nested',
      style: largeGraph
        ? {
            label: "",
            "background-opacity": 0,
            "border-opacity": 0,
            "border-width": 0,
            padding: "0px"
          }
        : {}
    },
    {
      // The selected nested folder temporarily regains its label for context.
      selector: 'node[kind = "folder"].folder-expanded.folder-depth-nested:selected',
      style: {
        label: "data(label)",
        "background-opacity": 0.18,
        "border-opacity": 1,
        "border-width": 2.5,
        padding: "12px",
        "text-background-color": C.panel,
        "text-background-opacity": 0.96,
        "text-background-padding": 3
      }
    },
    {
      selector: ".parse-error",
      style: {
        shape: "diamond",
        "border-color": C.coral,
        "border-width": 3.5,
        "background-color": "#321923"
      }
    },
    {
      selector: ".parse-warning",
      style: {
        "border-color": C.warning,
        "border-width": 3,
        "border-style": "dashed"
      }
    },
    {
      selector: ".cycle-node",
      style: {
        "border-color": C.coral,
        "border-width": 4,
        "border-opacity": 1
      }
    },
    {
      selector: ".blast-radius-node",
      style: {
        "border-color": C.rose,
        "border-width": 3,
        "border-style": "dashed",
        "border-opacity": 1
      }
    },
    {
      selector: ".heat-low",
      style: {
        "background-color": C.cyan,
        "border-color": C.text,
        "border-width": 1.5
      }
    },
    {
      selector: ".heat-medium",
      style: {
        "background-color": C.violet,
        "border-color": C.text,
        "border-width": 2
      }
    },
    {
      selector: ".heat-high",
      style: {
        "background-color": C.coral,
        "border-color": C.text,
        "border-width": 3.5
      }
    },
    {
      selector: ".heat-unavailable",
      style: {
        "background-color": C.raised,
        "border-color": C.muted,
        "border-width": 2.5,
        "border-style": "dashed"
      }
    },
    {
      selector: "edge",
      style: {
        width: largeGraph ? 0.7 : 1.1,
        "line-color": "#495169",
        "target-arrow-color": C.cyan,
        "target-arrow-shape": "triangle",
        "arrow-scale": largeGraph ? 0.55 : 0.7,
        "curve-style": largeGraph ? "haystack" : "bezier",
        opacity: largeGraph ? 0.5 : 0.76,
        "overlay-opacity": 0
      }
    },
    {
      selector: "edge.folder-aggregate-edge",
      style: {
        width: "mapData(importCount, 1, 40, 1.6, 6)",
        "line-color": C.cyan,
        "target-arrow-color": C.cyan,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
        opacity: 0.92,
        label: "data(label)",
        color: C.text,
        "font-size": 11,
        "font-weight": 700,
        "text-rotation": "none",
        "text-background-color": C.panel,
        "text-background-opacity": 0.96,
        "text-background-padding": 4,
        "text-outline-opacity": 0
      }
    },
    {
      selector: ".cycle-edge",
      style: {
        "line-color": C.coral,
        "target-arrow-color": C.coral,
        width: 2.4,
        opacity: 1
      }
    },
    {
      selector: ".call-edge",
      style: {
        "line-color": C.cyan,
        "target-arrow-color": C.cyan,
        "line-style": "dashed",
        width: 1.3,
        opacity: 0.9
      }
    },
    {
      selector: "node:selected",
      style: {
        label: "data(label)",
        "border-color": C.violet,
        "border-width": 3.5,
        "shadow-blur": 18,
        "shadow-color": C.violet,
        "shadow-opacity": 0.8,
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

/**
 * Layout settings.
 *
 * The graph is explicitly fit after layoutstop and after the canvas dimensions
 * settle. The layout engines don't try to fit the graph before the final
 * container size is known.
 *
 * @param {string} layout
 * @param {number} visibleNodeCount
 * @param {boolean} reducedMotion
 * @returns {object}
 */
function createLayoutOptions(
  layout,
  visibleNodeCount,
  reducedMotion,
  randomize = true
) {
  if (layout === "dagre") {
    return {
      name: "dagre",
      rankDir: "LR",
      nodeSep: visibleNodeCount <= 30 ? 65 : 90,
      rankSep: visibleNodeCount <= 30 ? 125 : 160,
      edgeSep: 18,
      fit: false,
      animate: false,
      padding: 35
    };
  }

  return {
    name: "fcose",
    quality: visibleNodeCount > 300 ? "draft" : "default",
    randomize,
    animate: randomize && visibleNodeCount <= 35 && !reducedMotion,
    animationDuration:
      visibleNodeCount <= 35 && !reducedMotion ? 220 : 0,
    fit: false,
    padding: 35,
    nodeDimensionsIncludeLabels: visibleNodeCount <= 45,

    nodeRepulsion: visibleNodeCount > 500
      ? 26000
      : visibleNodeCount > 120
        ? 18000
        : 14000,

    idealEdgeLength: visibleNodeCount > 500
      ? 145
      : visibleNodeCount > 120
        ? 125
        : 100,

    edgeElasticity: 0.35,
    nestingFactor: 0.12,
    gravity: 0.12,

    numIter: visibleNodeCount > 500
      ? 1200
      : visibleNodeCount <= 60
        ? 900
        : 1600,

    tile: true,
    packComponents: true
  };
}

function getViewLabel(view) {
  return view === "calls"
    ? "FUNCTION CALLS"
    : "FILE DEPENDENCIES";
}

function getTotalNodeLabel(view, graph) {
  const count = view === "calls"
    ? graph.functionNodes.size
    : graph.nodes.size;

  return `${count.toLocaleString()} ${
    view === "calls" ? "functions" : "files"
  }`;
}

/**
 * Apply complexity classes while keeping the current layout and viewport.
 *
 * @param {object} cy Cytoscape instance.
 * @param {boolean} enabled
 */
function applyHeatmap(cy, enabled) {
  const nodes = cy.nodes(
    '[kind = "file"], [kind = "function"]'
  );

  nodes.removeClass(
    "heat-low heat-medium heat-high heat-unavailable"
  );

  if (!enabled) {
    return;
  }

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
  const heatmapRef = useRef(heatmap);

  const expansionStateRef = useRef({
    graph: null,
    view: null,
    expandedFolders: new Set()
  });

  const [tooltip, setTooltip] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const [viewSummary, setViewSummary] = useState({
    visibleNodes: 0,
    folderCount: 0,
    collapsedFolders: 0
  });

  onSelectRef.current = onSelectFile;
  onLayoutRef.current = onLayoutComplete;
  onFpsRef.current = onFps;
  heatmapRef.current = heatmap;

  const cycleKey = cycleNodes.join("\u0000");
  const blastKey = blastRadiusPaths.join("\u0000");

  const allElements = useMemo(() => {
    const elements = graph.toCytoscapeElements({
      view,
      showClusters: true,
      cycleNodes,
      blastRadius: blastRadiusPaths
    });

    return prepareGraphNavigationElements(
      recolourElements(elements),
      view
    );
  }, [
    graph,
    view,
    cycleKey,
    blastKey
  ]);

  const complexitySummary = useMemo(
    () => countComplexityBands(
      view === "calls"
        ? graph.functionNodes.values()
        : graph.nodes.values()
    ),
    [graph, view]
  );

  const totalNodeCount = view === "calls"
    ? graph.functionNodes.size
    : graph.nodes.size;

  useImperativeHandle(ref, () => ({
    /** Fit and centre the current visible graph. */
    fit() {
      helperRef.current?.fit();
    },

    /**
     * Focus file paths or function IDs.
     *
     * @param {string[]} paths
     */
    focusPaths(paths) {
      helperRef.current?.focusPaths(paths);
    },

    /** Expand every folder cluster. */
    expandAll() {
      helperRef.current?.expandAll();
    },

    /** Collapse every folder cluster. */
    collapseAll() {
      helperRef.current?.collapseAll();
    }
  }), []);

  /*
   * Expanded mode uses an application-level fullscreen overlay instead of
   * browser-native fullscreen. This keeps its exit control, keyboard handling
   * and viewport resize behaviour under our direct control.
   */
  useEffect(() => {
    if (!isExpanded) {
      return undefined;
    }

    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleEscape(event) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsExpanded(false);
    }

    // Capture phase prevents the workspace Escape shortcut from also firing.
    document.addEventListener("keydown", handleEscape, true);

    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [isExpanded]);

  /*
   * The graph host changes size when the overlay opens/closes. Wait for the
   * browser to apply the CSS before resizing and fitting Cytoscape.
   */
  useEffect(() => {
    const cy = cyRef.current;

    if (!cy || cy.destroyed()) {
      return undefined;
    }

    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!cy.destroyed()) {
          cy.resize();
          cy.fit(cy.elements(), 65);
          cy.center(cy.elements());
        }
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [isExpanded]);

  useEffect(() => {
    if (!containerRef.current || !graph) {
      return undefined;
    }

    registerExtensions();

    const largeGraph = totalNodeCount > 500;

    const folderIds = new Set(
      allElements
        .filter(
          (element) =>
            element.group === "nodes" &&
            element.data.kind === "folder"
        )
        .map((element) => element.data.id)
    );

    const previousState = expansionStateRef.current;

    if (
      previousState.graph !== graph ||
      previousState.view !== view
    ) {
      expansionStateRef.current = {
        graph,
        view,
        expandedFolders: getInitialExpandedFolders(
          allElements,
          totalNodeCount,
          COLLAPSE_THRESHOLD
        )
      };
    } else {
      // Keep user choices when changing layout or analysis highlights.
      for (const folderId of previousState.expandedFolders) {
        if (!folderIds.has(folderId)) {
          previousState.expandedFolders.delete(folderId);
        }
      }
    }

    const expandedFolders =
      expansionStateRef.current.expandedFolders;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let initialFitComplete = false;

    const cy = cytoscape({
      container: containerRef.current,

      elements: getVisibleGraphElements(
        allElements,
        expandedFolders,
        view
      ),

      style: createStyles({ largeGraph }),

      layout: {
        name: "preset",
        fit: false
      },

      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      wheelSensitivity: 0.16,

      hideEdgesOnViewport: totalNodeCount > 120,
      hideLabelsOnViewport: totalNodeCount > 60,
      textureOnViewport: totalNodeCount > 120,

      motionBlur: false,
      pixelRatio: largeGraph ? 1 : "auto",
      selectionType: "single"
    });

    cyRef.current = cy;

    function updateViewSummary() {
      setViewSummary({
        visibleNodes: cy.nodes().length,
        folderCount: folderIds.size,

        // Count only collapsed folders currently visible to the user, not
        // every nested folder hidden inside a collapsed ancestor.
        collapsedFolders: cy.nodes(
          'node[kind = "folder"].folder-collapsed'
        ).length
      });
    }

    function updateLabelDensity() {
      if (cy.destroyed()) {
        return;
      }

      const hide =
        cy.nodes().length > 45 &&
        cy.zoom() < labelThreshold(cy.nodes().length);

      const nodes = cy.nodes(
        '[kind = "file"], [kind = "function"]'
      );

      cy.batch(() => {
        nodes.forEach((node) => {
          if (hide && !node.hasClass("labels-hidden")) {
            node.addClass("labels-hidden");
          } else if (
            !hide &&
            node.hasClass("labels-hidden")
          ) {
            node.removeClass("labels-hidden");
          }
        });
      });
    }

    /**
     * Centre the requested visible elements in the current graph host.
     *
     * @param {object} collection Cytoscape collection.
     * @param {number} [padding=65]
     */
    function fitCollection(collection, padding = 65) {
      if (
        cy.destroyed() ||
        !containerRef.current ||
        containerRef.current.clientWidth < 10 ||
        containerRef.current.clientHeight < 10
      ) {
        return;
      }

      const target = collection?.length
        ? collection
        : cy.elements();

      if (target.length === 0) {
        return;
      }

      cy.resize();
      cy.fit(target, padding);
      cy.center(target);
      updateLabelDensity();
    }

    /**
     * Find the rendered node(s) matching paths or node IDs.
     *
     * @param {Iterable<string>} paths
     * @returns {object}
     */
    function findTargets(paths) {
      const requested = new Set(paths ?? []);

      return cy.nodes().filter((node) => {
        const data = node.data();

        return (
          requested.has(data.path) ||
          requested.has(data.filePath) ||
          requested.has(data.id)
        );
      });
    }

    /**
     * Run a layout, then fit after two animation frames.
     *
     * @param {{focusPaths?:string[]|null,fitAll?:boolean}} [options]
     */
    function runLayout({
      focusPaths = null,
      fitAll = true,
      randomize = true
    } = {}) {
      if (cy.destroyed()) {
        return;
      }

      const currentCount = cy.nodes().length;
      const start = performance.now();

      if (currentCount === 0) {
        updateViewSummary();
        return;
      }

      const options = createLayoutOptions(
        layout,
        currentCount,
        reducedMotion,
        randomize
      );

      function finish() {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (cy.destroyed()) {
              return;
            }

            cy.resize();

            if (focusPaths?.length) {
              const targets = findTargets(focusPaths);

              if (targets.length > 0) {
                cy.nodes().unselect();
                targets.select();
                fitCollection(targets, 90);
              } else if (fitAll) {
                fitCollection(cy.elements(), 65);
              }
            } else if (fitAll) {
              fitCollection(cy.elements(), 65);
            }

            initialFitComplete = true;

            updateLabelDensity();
            updateViewSummary();

            onLayoutRef.current?.(
              performance.now() - start
            );
          });
        });
      }

      try {
        const nextLayout = cy.layout(options);
        nextLayout.one("layoutstop", finish);
        nextLayout.run();
      } catch (error) {
        console.warn(
          `Layout ${layout} failed; trying the built-in COSE layout.`,
          error
        );

        const fallback = cy.layout({
          name: "cose",
          animate: false,
          fit: false,
          padding: 35,
          nodeRepulsion: 16000,
          idealEdgeLength: 120,
          randomize
        });

        fallback.one("layoutstop", finish);
        fallback.run();
      }
    }

    /**
     * Rebuild the visible graph after expansion changes.
     * The complete analysis graph is never edited.
     */
    function refreshVisibleElements({
      focusPaths = null,
      fitAll = true,
      randomize = false
    } = {}) {
      if (cy.destroyed()) {
        return;
      }

      // Keep the positions of nodes that remain visible. Newly revealed
      // children start near their closest visible parent, so expanding one
      // directory does not randomize the entire atlas from scratch.
      const previousPositions = new Map();

      cy.nodes().forEach((node) => {
        const position = node.position();

        if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
          previousPositions.set(node.id(), {
            x: position.x,
            y: position.y
          });
        }
      });

      const extent = cy.extent();
      const graphCenter = {
        x: (extent.x1 + extent.x2) / 2,
        y: (extent.y1 + extent.y2) / 2
      };

      function nearbyPosition(origin, id) {
        let hash = 0;

        for (let index = 0; index < id.length; index += 1) {
          hash = (hash * 31 + id.charCodeAt(index)) | 0;
        }

        const positiveHash = Math.abs(hash);
        const angle = (positiveHash % 360) * (Math.PI / 180);
        const radius = 45 + ((positiveHash >>> 8) % 6) * 24;

        return {
          x: origin.x + Math.cos(angle) * radius,
          y: origin.y + Math.sin(angle) * radius
        };
      }

      const nextElements = getVisibleGraphElements(
        allElements,
        expandedFolders,
        view
      ).map((element) => {
        if (element.group !== "nodes") {
          return element;
        }

        const id = element.data?.id;
        const existingPosition = previousPositions.get(id);

        if (existingPosition) {
          return { ...element, position: existingPosition };
        }

        const parentPosition = previousPositions.get(
          element.data?.parent
        );

        return {
          ...element,
          position: nearbyPosition(
            parentPosition ?? graphCenter,
            String(id ?? "new-node")
          )
        };
      });

      cy.batch(() => {
        cy.elements().remove();
        cy.add(nextElements);
      });

      // Apply the latest heatmap state after replacing the node elements.
      applyHeatmap(cy, heatmapRef.current);

      updateViewSummary();
      updateLabelDensity();

      runLayout({
        focusPaths,
        fitAll,
        randomize
      });
    }

    function toggleFolder(folderId) {
      if (!folderIds.has(folderId)) {
        return;
      }

      if (expandedFolders.has(folderId)) {
        expandedFolders.delete(folderId);
      } else {
        expandedFolders.add(folderId);
      }

      setTooltip(null);
      refreshVisibleElements();
    }

    /**
     * Expand parent folders before focusing a hidden file/function.
     *
     * @param {Iterable<string>} paths
     */
    function focusPaths(paths) {
      const requested = new Set(paths ?? []);

      if (requested.size === 0 || cy.destroyed()) {
        return;
      }

      let expansionChanged = false;
      const elementDataById = new Map(
        allElements
          .filter((element) => element.group === "nodes")
          .map((element) => [element.data?.id, element.data])
      );

      for (const element of allElements) {
        if (element.group !== "nodes") {
          continue;
        }

        const data = element.data;
        const isRequestedTarget =
          data.kind !== "folder" &&
          (
            requested.has(data.path) ||
            requested.has(data.filePath) ||
            requested.has(data.id)
          );

        if (!isRequestedTarget) {
          continue;
        }

        // With nested folder clusters, every ancestor must be expanded before
        // the requested file or function can become visible.
        let parentId = data.parent;
        const visitedParents = new Set();

        while (parentId && !visitedParents.has(parentId)) {
          visitedParents.add(parentId);

          if (!expandedFolders.has(parentId)) {
            expandedFolders.add(parentId);
            expansionChanged = true;
          }

          parentId = elementDataById.get(parentId)?.parent;
        }
      }

      setTooltip(null);

      if (expansionChanged) {
        refreshVisibleElements({
          focusPaths: [...requested],
          fitAll: false
        });

        return;
      }

      const targets = findTargets(requested);

      if (targets.length === 0) {
        return;
      }

      cy.nodes().unselect();
      targets.select();
      fitCollection(targets, 90);
    }

    function expandAll() {
      let changed = false;

      for (const folderId of folderIds) {
        if (!expandedFolders.has(folderId)) {
          expandedFolders.add(folderId);
          changed = true;
        }
      }

      setTooltip(null);

      if (changed) {
        // Expanding every nested directory can add thousands of nodes whose
        // first positions all originate near the same parent/graph centre.
        // A fresh force-directed initialization is essential here; preserving
        // those temporary positions creates a pile of overlapping compound
        // folders and can make the canvas look like one solid colour.
        refreshVisibleElements({ randomize: true });
        return;
      }

      // Also let the control recover an already-expanded graph if its previous
      // layout was interrupted or left in a degenerate position.
      runLayout({ fitAll: true, randomize: true });
    }

    function collapseAll() {
      expandedFolders.clear();
      refreshVisibleElements();
    }

    cy.on("tap", 'node[kind = "folder"]', (event) => {
      const node = event.target;
      const data = node.data();
      const position = node.renderedPosition();

      cy.nodes().unselect();
      node.select();

      setTooltip({
        title: data.folderPath ?? data.baseLabel ?? data.label,
        path: data.folderPath ?? null,
        kind: "folder",
        fileCount: data.fileCount ?? 0,
        internalRelationshipCount:
          data.internalRelationshipCount ?? 0,
        cycleCount: data.cycleCount ?? 0,
        x: position.x,
        y: position.y
      });
    });

    cy.on("dbltap", 'node[kind = "folder"]', (event) => {
      toggleFolder(event.target.id());
    });

    cy.on("tap", 'node[kind = "file"]', (event) => {
      const node = event.target;
      const path = node.data("path");

      cy.nodes().unselect();
      node.select();
      setTooltip(null);

      if (path) {
        onSelectRef.current?.(path);
      }
    });

    cy.on("tap", 'node[kind = "function"]', (event) => {
      const node = event.target;
      const path = node.data("filePath");

      cy.nodes().unselect();
      node.select();
      setTooltip(null);

      if (path) {
        onSelectRef.current?.(path);
      }
    });

    cy.on("mouseover", "node", (event) => {
      const node = event.target;
      const data = node.data();
      const position = node.renderedPosition();

      setTooltip({
        title: data.baseLabel ?? data.label ?? data.id,
        path: data.path ?? data.filePath ?? null,
        kind: data.kind,
        complexity: data.cyclomaticComplexity ?? null,
        loc: data.loc ?? null,
        parseStatus: data.parseStatus ?? null,
        fileCount: data.fileCount ?? null,
        internalRelationshipCount:
          data.internalRelationshipCount ?? null,
        cycleCount: data.cycleCount ?? null,
        x: position.x,
        y: position.y
      });
    });

    cy.on("mouseout", "node", () => {
      setTooltip(null);
    });

    cy.on("zoom pan", updateLabelDensity);

    helperRef.current = {
      fit() {
        fitCollection(cy.elements(), 65);
      },

      focusPaths,

      expandAll,

      collapseAll
    };

    applyHeatmap(cy, heatmapRef.current);
    updateViewSummary();

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (cy.destroyed()) {
              return;
            }

            cy.resize();

            // Auto-fit while the first layout is settling. Afterward, preserve
            // user zoom/pan unless the explicit Fit control is pressed.
            if (!initialFitComplete) {
              requestAnimationFrame(() => {
                if (!cy.destroyed() && !initialFitComplete) {
                  fitCollection(cy.elements(), 65);
                }
              });
            }
          })
        : null;

    resizeObserver?.observe(containerRef.current);

    runLayout();

    return () => {
      resizeObserver?.disconnect();

      helperRef.current = null;
      cy.destroy();

      if (cyRef.current === cy) {
        cyRef.current = null;
      }
    };
  }, [
    graph,
    allElements,
    layout,
    view
  ]);

  /*
   * Heatmap changes only style classes, not graph elements or layout.
   */
  useEffect(() => {
    const cy = cyRef.current;

    if (cy && !cy.destroyed()) {
      applyHeatmap(cy, heatmap);
    }
  }, [heatmap]);

  /*
   * Sample animation-frame cadence for the benchmark panel.
   * This is a frame-loop estimate, not a guaranteed GPU paint FPS reading.
   */
  useEffect(() => {
    let frameId = 0;
    let frames = 0;
    let start = performance.now();
    let active = true;

    function tick(time) {
      if (!active) {
        return;
      }

      if (document.visibilityState === "hidden") {
        frames = 0;
        start = time;
      } else {
        frames += 1;

        const elapsed = time - start;

        if (elapsed >= 1000) {
          onFpsRef.current?.(
            Math.round((frames * 1000) / elapsed)
          );

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
    <div
      className={[
        "aa-graph-shell",
        "aa-graph-ux",
        isExpanded ? "aa-graph-expanded" : ""
      ].filter(Boolean).join(" ")}
      role={isExpanded ? "dialog" : undefined}
      aria-modal={isExpanded ? "true" : undefined}
      aria-label={isExpanded ? "Expanded repository graph" : undefined}
    >
      <div
        className="aa-graph-canvas"
        ref={containerRef}
        aria-label="Interactive repository dependency graph"
      />

      <div className="aa-graph-overlay aa-graph-overlay-top">
        <span className="aa-graph-status">
          {getViewLabel(view)}
        </span>

        <span className="aa-graph-status">
          {getTotalNodeLabel(view, graph)}
        </span>
      </div>

      <div className="aa-graph-onboarding">
        <strong>
          {isExpanded
            ? "Focused graph workspace"
            : "Explore the architecture"}
        </strong>

        <span>
          Double-click a folder to open its contents. Click a file to inspect it.
          Use Fit to centre the visible graph.
        </span>

        {viewSummary.collapsedFolders > 0 && (
          <span>
            {viewSummary.collapsedFolders} {viewSummary.collapsedFolders === 1 ? "folder" : "folders"} collapsed ·{" "}
            {viewSummary.visibleNodes} visible graph nodes
          </span>
        )}

        {viewSummary.folderCount > 0 &&
          viewSummary.collapsedFolders === 0 && (
            <span>
              All {viewSummary.folderCount} folders are expanded.
            </span>
          )}

        {totalNodeCount > 500 && viewSummary.collapsedFolders === 0 && (
          <span>
            Large-graph view: nested folder boxes and labels are simplified
            for readability. Use Collapse all for a clean folder overview.
          </span>
        )}
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
            Complexity colours apply to files/functions, not folder backgrounds.
            Dashed nodes indicate unavailable metrics or parse warnings.
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
                (containerRef.current?.clientWidth ?? 300) - 245
              )
            )}px`,

            top: `${Math.max(44, tooltip.y + 12)}px`
          }}
        >
          <strong>{tooltip.title}</strong>

          {tooltip.path && (
            <span>{tooltip.path}</span>
          )}

          {tooltip.loc != null && (
            <span>{tooltip.loc} lines</span>
          )}

          {tooltip.complexity != null && (
            <span>Complexity {tooltip.complexity}</span>
          )}

          {tooltip.fileCount != null && (
            <span>{tooltip.fileCount} files/functions</span>
          )}

          {tooltip.internalRelationshipCount != null && (
            <span>
              {tooltip.internalRelationshipCount} internal relationships
            </span>
          )}

          {tooltip.cycleCount > 0 && (
            <span>{tooltip.cycleCount} cyclic children</span>
          )}

          {tooltip.parseStatus === "error" && (
            <span>Parsing failed</span>
          )}
        </div>
      )}

      <div
        className="aa-graph-controls"
        aria-label="Graph navigation controls"
      >
        <div className="aa-graph-control-group">
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => {
              const cy = cyRef.current;

              if (!cy || !containerRef.current) {
                return;
              }

              cy.zoom({
                level: Math.min(MAX_ZOOM, cy.zoom() * 1.25),

                renderedPosition: {
                  x: containerRef.current.clientWidth / 2,
                  y: containerRef.current.clientHeight / 2
                }
              });
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

              if (!cy || !containerRef.current) {
                return;
              }

              cy.zoom({
                level: Math.max(MIN_ZOOM, cy.zoom() / 1.25),

                renderedPosition: {
                  x: containerRef.current.clientWidth / 2,
                  y: containerRef.current.clientHeight / 2
                }
              });
            }}
          >
            −
          </button>

          <button
            type="button"
            className="aa-graph-fit-button"
            aria-label="Fit and centre the visible graph"
            title="Fit and centre the visible graph"
            onClick={() => helperRef.current?.fit()}
          >
            Fit
          </button>
        </div>

        <div className="aa-graph-control-group">
          <button
            type="button"
            aria-label="Expand all folders"
            title="Expand all folders"
            onClick={() => helperRef.current?.expandAll()}
          >
            Expand all
          </button>

          <button
            type="button"
            aria-label="Collapse all folders"
            title="Collapse all folders"
            onClick={() => helperRef.current?.collapseAll()}
          >
            Collapse all
          </button>
        </div>

        <div className="aa-graph-control-group">
          <button
            type="button"
            className="aa-graph-expand-button"
            aria-label={
              isExpanded
                ? "Exit expanded graph view"
                : "Expand graph to fill the screen"
            }
            aria-pressed={isExpanded}
            title={
              isExpanded
                ? "Return to the repository workspace"
                : "Expand graph to fill the screen"
            }
            onClick={() => setIsExpanded((value) => !value)}
          >
            {isExpanded ? "Exit expanded view" : "Expand view"}
          </button>
        </div>
      </div>

      <p className="aa-graph-help">
        Drag to pan · Scroll to zoom · Hover for details · Double-click folders
        to expand/collapse
        {isExpanded ? " · Press Esc to exit expanded view" : ""}
      </p>
    </div>
  );
});

export default AtlasGraph;
