/**
 * Astral Atlas analysis workspace.
 *
 * Navigation contract:
 * - Selecting a file never opens source code automatically.
 * - Selecting a file focuses its node in the existing graph.
 * - A one-hop neighbourhood can be focused independently.
 * - Source Explorer opens only on an explicit source action.
 * - The workspace remains mounted beneath Source Explorer.
 * - Browser Back and the visible Back button return to the same atlas.
 */

import React, {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import AtlasGraph from "./AtlasGraph.jsx";
import CodePanel from "./CodePanel.jsx";

import BlastRadiusAnalyzer from "../engine/BlastRadiusAnalyzer.js";

import {
  createSourceExplorerModel,
  getFileNeighborhood
} from "../engine/sourceExplorerModel.js";

import "../styles/atlas-navigation.css";

const SourceExplorer = lazy(
  () => import("./SourceExplorer.jsx")
);

const numberFormat = new Intl.NumberFormat("en-US");

function Metric({ label, value }) {
  return (
    <div className="aa-summary-metric">
      <span>{label}</span>
      <strong>{numberFormat.format(value ?? 0)}</strong>
    </div>
  );
}

function readHistoryState() {
  const value = window.history.state;

  return value && typeof value === "object"
    ? value
    : {};
}

/**
 * @param {{
 *   analysis:object,
 *   controller:object,
 *   onBack:()=>void
 * }} props
 */
export default function AtlasWorkspace({
  analysis,
  controller,
  onBack
}) {
  const graph = analysis.graph;

  const graphRef = useRef(null);
  const searchRef = useRef(null);

  // Source text is cached only in this component's memory.
  const sourceCacheRef = useRef(new Map());

  // Refs let event handlers see the current source-screen state immediately,
  // without waiting for React to render the next state.
  const sourceScreenOpenRef = useRef(false);
  const sourceHistoryEntryRef = useRef(false);

  const [selectedPath, setSelectedPath] = useState(
    graph.nodes.keys().next().value ?? null
  );

  const [source, setSource] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState(null);

  const [sourceScreenOpen, setSourceScreenOpen] = useState(false);
  const [sourceReloadVersion, setSourceReloadVersion] = useState(0);
  const [jumpToLine, setJumpToLine] = useState(1);

  const [layout, setLayout] = useState("fcose");
  const [view, setView] = useState("dependencies");
  const [heatmap, setHeatmap] = useState(false);
  const [query, setQuery] = useState("");
  const [blastRadiusPaths, setBlastRadiusPaths] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const selectedSourceModel = useMemo(
    () => createSourceExplorerModel(graph, selectedPath),
    [graph, selectedPath]
  );

  const selectedFile = selectedSourceModel?.file ?? null;

  const fileList = useMemo(
    () => [...graph.nodes.values()].sort(
      (a, b) => a.path.localeCompare(b.path)
    ),
    [graph]
  );

  const filteredFiles = useMemo(() => {
    const term = query.trim().toLowerCase();

    if (!term) {
      return fileList;
    }

    return fileList.filter((file) =>
      file.path.toLowerCase().includes(term) ||
      file.label.toLowerCase().includes(term) ||
      file.folder.toLowerCase().includes(term)
    );
  }, [fileList, query]);

  const selectedFunctions =
    selectedSourceModel?.functions ?? [];

  const selectedImports =
    selectedSourceModel?.imports ?? [];

  const selectedImportedBy =
    selectedSourceModel?.importedBy ?? [];

  /**
   * Select a file in the graph.
   *
   * This intentionally does NOT open Source Explorer.
   *
   * @param {string} path
   */
  function selectFile(path) {
    if (!graph.nodes.has(path)) {
      return;
    }

    setSelectedPath(path);

    graphRef.current?.focusPaths([path]);
  }

  /**
   * Open a selected file in the dedicated source screen.
   *
   * The first opening creates a browser history entry. Changing files while
   * Source Explorer is open replaces that entry rather than adding an entry
   * for every file. This makes Back return to the Atlas.
   *
   * @param {string} path
   * @param {number} [line]
   */
  function openSource(path, line = 1) {
    if (!graph.nodes.has(path)) {
      return;
    }

    const safeLine = Number.isFinite(line) && line > 0
      ? Math.floor(line)
      : 1;

    const alreadyOpen = sourceScreenOpenRef.current;

    if (!alreadyOpen) {
      const currentHistoryState = readHistoryState();

      window.history.pushState(
        {
          ...currentHistoryState,
          astralAtlasSource: true,
          sourcePath: path,
          sourceLine: safeLine
        },
        "",
        window.location.href
      );

      sourceHistoryEntryRef.current = true;
    } else {
      const currentHistoryState = readHistoryState();

      // Keep one source-screen history entry while switching between files.
      if (currentHistoryState.astralAtlasSource === true) {
        window.history.replaceState(
          {
            ...currentHistoryState,
            sourcePath: path,
            sourceLine: safeLine
          },
          "",
          window.location.href
        );
      }
    }

    sourceScreenOpenRef.current = true;

    setSelectedPath(path);
    setJumpToLine(safeLine);
    setSourceScreenOpen(true);

    // A version of zero allows valid in-memory source-cache entries to be used.
    setSourceReloadVersion(0);
  }

  /**
   * Focus the selected file and its immediate import neighbourhood.
   *
   * The rest of the graph remains present. This is a focused view of the
   * existing dependency graph, not a destructive graph filter.
   *
   * @param {string} path
   */
  function focusRelated(path) {
    if (!graph.nodes.has(path)) {
      return;
    }

    const neighbourhood = getFileNeighborhood(graph, path);

    setSelectedPath(path);

    graphRef.current?.focusPaths(neighbourhood);
  }

  /**
   * Close Source Explorer and return to the existing Atlas.
   */
  function handleSourceBack() {
    sourceScreenOpenRef.current = false;
    sourceHistoryEntryRef.current = false;

    setSourceScreenOpen(false);

    // The popstate handler also handles a user pressing the browser Back
    // button. The visible Back button updates the UI immediately.
    if (window.history.state?.astralAtlasSource === true) {
      window.history.back();
    }
  }

  /**
   * Reload source after a failed read.
   */
  function handleSourceRetry() {
    if (!selectedPath) {
      return;
    }

    sourceCacheRef.current.delete(selectedPath);
    setSource(null);
    setSourceError(null);
    setSourceReloadVersion((version) => version + 1);
  }

  /**
   * Respond to browser Back/Forward.
   *
   * When Back leaves the source history entry, the Atlas is revealed.
   * When Forward returns to the source entry, the previous source screen
   * and selected file are restored.
   */
  useEffect(() => {
    function handlePopState() {
      const historyState = readHistoryState();

      if (
        historyState.astralAtlasSource === true &&
        typeof historyState.sourcePath === "string" &&
        graph.nodes.has(historyState.sourcePath)
      ) {
        sourceHistoryEntryRef.current = true;
        sourceScreenOpenRef.current = true;

        setSelectedPath(historyState.sourcePath);

        setJumpToLine(
          Number.isFinite(historyState.sourceLine) &&
            historyState.sourceLine > 0
            ? historyState.sourceLine
            : 1
        );

        setSourceReloadVersion(0);
        setSourceScreenOpen(true);
        return;
      }

      sourceHistoryEntryRef.current = false;
      sourceScreenOpenRef.current = false;

      setSourceScreenOpen(false);
    }

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [graph]);

  /**
   * Retrieve source only while Source Explorer is open.
   *
   * Unavailable source remains a retryable error. Successful source text is
   * reused while this workspace remains mounted.
   */
  useEffect(() => {
    let active = true;

    if (!sourceScreenOpen || !selectedPath) {
      setSourceLoading(false);
      return undefined;
    }

    const forceReload = sourceReloadVersion > 0;

    if (
      !forceReload &&
      sourceCacheRef.current.has(selectedPath)
    ) {
      setSource(sourceCacheRef.current.get(selectedPath));
      setSourceError(null);
      setSourceLoading(false);

      return undefined;
    }

    setSource(null);
    setSourceError(null);
    setSourceLoading(true);

    controller.getSource(selectedPath)
      .then((text) => {
        if (!active) {
          return;
        }

        sourceCacheRef.current.set(selectedPath, text);
        setSource(text);
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setSourceError(
          error?.message ??
            "Could not load this source file."
        );
      })
      .finally(() => {
        if (active) {
          setSourceLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    controller,
    selectedPath,
    sourceScreenOpen,
    sourceReloadVersion
  ]);

  function selectStarter(starter) {
    try {
      const result = new BlastRadiusAnalyzer().analyze(
        graph,
        starter.path
      );

      setBlastRadiusPaths(
        result.impacted.map((item) => item.path)
      );
    } catch (error) {
      setBlastRadiusPaths([]);

      console.error(
        "Could not calculate the starter-file blast radius.",
        error
      );
    }

    // Starter selection focuses the graph first; opening source is explicit.
    selectFile(starter.path);
  }

  function focusCycle(cycle) {
    graphRef.current?.focusPaths(cycle.nodes);
  }

  useEffect(() => {
    function handleKeys(event) {
      const isMac =
        navigator.platform.toLowerCase().includes("mac");

      const modifier = isMac
        ? event.metaKey
        : event.ctrlKey;

      if (
        modifier &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();

        if (!sourceScreenOpenRef.current) {
          searchRef.current?.focus();
        }

        return;
      }

      if (event.key === "Escape") {
        if (sourceScreenOpenRef.current) {
          handleSourceBack();
        } else {
          setQuery("");
          setShowShortcuts(false);
        }

        return;
      }

      const tag = event.target?.tagName?.toLowerCase();

      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        event.target?.isContentEditable
      ) {
        return;
      }

      if (sourceScreenOpenRef.current) {
        return;
      }

      if (event.key.toLowerCase() === "f") {
        graphRef.current?.fit();
      } else if (event.key === "1") {
        setLayout("fcose");
      } else if (event.key === "2") {
        setLayout("dagre");
      }
    }

    window.addEventListener("keydown", handleKeys);

    return () => {
      window.removeEventListener("keydown", handleKeys);
    };
  }, []);

  function exportBenchmark() {
    const payload = {
      product: "Astral Atlas",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),

      repository: {
        name: analysis.repo?.fullName ?? null,
        source: analysis.repo?.source ?? null,
        branch: analysis.repo?.branch ?? null
      },

      timings: {
        ...analysis.benchmark
      },

      graph: {
        ...analysis.stats
      },

      cycles: {
        groups: analysis.cycles.cycles.length,
        cyclicFiles: analysis.cycles.cyclicNodes.length
      },

      callResolution: {
        ...analysis.callResolution.stats
      },

      methodology: {
        fetchMs:
          "Repository-loading phase, including tree retrieval, configuration retrieval, cache checking and downloads.",
        parseMs:
          "ParserPool duration, including parsing and cache writes.",
        graphMs:
          "Graph construction, call resolution, cycle detection and starter-file ranking.",
        layoutMs:
          "Cytoscape layout completion duration.",
        fps:
          "Approximate requestAnimationFrame rate, not guaranteed GPU paint throughput."
      }
    };

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "astral-atlas-benchmark.json";

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  const percent = (value) =>
    Number.isFinite(value)
      ? `${(value * 100).toFixed(1)}%`
      : "—";

  return (
    <main className="aa-workspace">
      <header className="aa-workspace-header">
        <div className="aa-brand">
          <div className="aa-brand-mark" aria-hidden="true">✳</div>

          <div>
            <strong>Astral Atlas</strong>
            <span>Repository cartography</span>
          </div>
        </div>

        <div className="aa-repo-heading">
          <span className="aa-eyebrow">CURRENT REPOSITORY</span>

          <strong title={analysis.repo?.fullName}>
            {analysis.repo?.fullName ?? analysis.repo?.repo}
          </strong>
        </div>

        <div className="aa-workspace-actions">
          <button
            type="button"
            className="aa-button aa-button-secondary"
            onClick={() => setShowShortcuts((value) => !value)}
          >
            Shortcuts
          </button>

          <button
            type="button"
            className="aa-button aa-button-secondary"
            onClick={exportBenchmark}
          >
            Export benchmark
          </button>

          <button
            type="button"
            className="aa-button aa-button-primary"
            onClick={onBack}
          >
            New repository
          </button>
        </div>
      </header>

      {showShortcuts && (
        <div
          className="aa-shortcuts"
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <div className="aa-shortcuts-heading">
            <strong>Keyboard shortcuts</strong>

            <button
              type="button"
              aria-label="Close shortcuts"
              onClick={() => setShowShortcuts(false)}
            >
              ×
            </button>
          </div>

          <p><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> Search files</p>
          <p><kbd>Esc</kbd> Return from Source Explorer or clear search</p>
          <p><kbd>F</kbd> Fit graph to screen</p>
          <p><kbd>1</kbd> Force-directed layout</p>
          <p><kbd>2</kbd> Hierarchical layout</p>
        </div>
      )}

      <section className="aa-summary-strip" aria-label="Repository summary">
        <Metric label="Files" value={analysis.stats.files} />
        <Metric label="Import edges" value={analysis.stats.edges} />
        <Metric label="Functions" value={analysis.stats.functions} />
        <Metric
          label="External packages"
          value={analysis.stats.externalDependencies}
        />
        <Metric
          label="Circular groups"
          value={analysis.cycles.cycles.length}
        />
        <Metric
          label="Orphan files"
          value={analysis.stats.orphanFiles}
        />
      </section>

      {(analysis.loaded.warnings?.length ?? 0) > 0 && (
        <section
          className="aa-warning-stack"
          aria-label="Analysis warnings"
        >
          {analysis.loaded.warnings.map((warning, index) => (
            <p key={`${index}-${warning}`}>{warning}</p>
          ))}
        </section>
      )}

      <section className="aa-workspace-toolbar">
        <div className="aa-toolbar-group">
          <label className="aa-control-label" htmlFor="aa-layout">
            Layout
          </label>

          <select
            id="aa-layout"
            value={layout}
            onChange={(event) => setLayout(event.target.value)}
          >
            <option value="fcose">Force-directed</option>
            <option value="dagre">Hierarchical</option>
          </select>
        </div>

        <div className="aa-toolbar-group">
          <label className="aa-control-label" htmlFor="aa-view">
            Graph
          </label>

          <select
            id="aa-view"
            value={view}
            onChange={(event) => setView(event.target.value)}
          >
            <option value="dependencies">File dependencies</option>
            <option value="calls">Function calls</option>
          </select>
        </div>

        <label className="aa-switch-label">
          <input
            type="checkbox"
            checked={heatmap}
            onChange={(event) => setHeatmap(event.target.checked)}
          />
          Complexity heatmap
        </label>

        <div className="aa-search-wrap">
          <label
            className="aa-visually-hidden"
            htmlFor="aa-file-search"
          >
            Search repository files
          </label>

          <input
            id="aa-file-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files or folders"
          />

          <span aria-hidden="true">Ctrl K</span>
        </div>
      </section>

      <div className="aa-workspace-grid">
        <aside className="aa-insights-panel">
          <section className="aa-insight-section">
            <p className="aa-eyebrow">ORIENTATION</p>
            <h2>Where to start</h2>

            {analysis.starterFiles.length === 0 ? (
              <p className="aa-muted-text">
                No files have enough valid metrics for a recommendation.
              </p>
            ) : (
              <ol className="aa-starter-list">
                {analysis.starterFiles.slice(0, 8).map((starter) => (
                  <li key={starter.path}>
                    <button
                      type="button"
                      onClick={() => selectStarter(starter)}
                      title={starter.explanation}
                    >
                      <span>{starter.path}</span>
                      <strong>{starter.score.toFixed(1)}</strong>
                    </button>

                    <small>
                      Impact {starter.blastRadius} files ·{" "}
                      {starter.loc} LOC · Complexity{" "}
                      {starter.cyclomaticComplexity}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="aa-insight-section">
            <p className="aa-eyebrow">CIRCULAR PATHS</p>
            <h2>Detected cycles</h2>

            {analysis.cycles.cycles.length === 0 ? (
              <p className="aa-muted-text">
                No circular import groups detected in the current graph.
              </p>
            ) : (
              <ol className="aa-cycle-list">
                {analysis.cycles.cycles.slice(0, 12).map((cycle) => (
                  <li key={cycle.id}>
                    <button
                      type="button"
                      onClick={() => focusCycle(cycle)}
                    >
                      <strong>{cycle.id}</strong>
                      <span>{cycle.size} files</span>
                    </button>

                    <small>
                      {cycle.shortestPath?.join(" → ") ??
                        cycle.nodes.join(", ")}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="aa-insight-section">
            <p className="aa-eyebrow">FILE INDEX</p>
            <h2>Files ({filteredFiles.length})</h2>

            {filteredFiles.length === 0 ? (
              <p className="aa-muted-text">
                No files match this search.
              </p>
            ) : (
              <ul className="aa-file-list">
                {filteredFiles.slice(0, 500).map((file) => (
                  <li key={file.path}>
                    <div className="aa-file-row">
                      <button
                        type="button"
                        className={`aa-file-select ${
                          file.path === selectedPath
                            ? "aa-file-active"
                            : ""
                        }`}
                        onClick={() => selectFile(file.path)}
                        title={`Focus ${file.path} in the graph`}
                        aria-current={
                          file.path === selectedPath
                            ? "true"
                            : undefined
                        }
                      >
                        <span
                          className={`aa-file-status aa-file-${file.parseStatus}`}
                          aria-hidden="true"
                        />

                        <span>{file.path}</span>
                      </button>

                      <button
                        type="button"
                        className="aa-file-open-source"
                        onClick={() => openSource(file.path, 1)}
                        aria-label={`Open source for ${file.path}`}
                        title={`Open source for ${file.path}`}
                      >
                        {"</>"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {filteredFiles.length > 500 && (
              <p className="aa-muted-text">
                Showing the first 500 matches. Refine the search to narrow
                the list.
              </p>
            )}
          </section>
        </aside>

        <section className="aa-atlas-panel">
          <div className="aa-panel-topline">
            <div>
              <p className="aa-eyebrow">DEPENDENCY CONSTELLATION</p>

              <h2>
                {view === "calls"
                  ? "Function call graph"
                  : "Repository atlas"}
              </h2>
            </div>

            <div
              className="aa-graph-legend"
              aria-label="Graph legend"
            >
              <span><i className="aa-legend-dot aa-legend-folder" /> Folder cluster</span>
              <span><i className="aa-legend-dot aa-legend-cycle" /> Circular path</span>
              <span><i className="aa-legend-dot aa-legend-impact" /> Blast radius</span>
              <span><i className="aa-legend-dot aa-legend-error" /> Parse error</span>
            </div>
          </div>

          <AtlasGraph
            ref={graphRef}
            graph={graph}
            layout={layout}
            view={view}
            cycleNodes={analysis.cycles.cyclicNodes}
            blastRadiusPaths={blastRadiusPaths}
            heatmap={heatmap}
            onSelectFile={selectFile}
            onLayoutComplete={(ms) =>
              controller.recordLayoutMeasurement(ms)
            }
            onFps={(fps) => controller.recordFps(fps)}
          />

          <div className="aa-graph-footer">
            <span>
              Calls: {analysis.callResolution.stats.resolved} resolved ·{" "}
              {analysis.callResolution.stats.ambiguous} ambiguous ·{" "}
              {analysis.callResolution.stats.unresolved} unresolved
            </span>

            <span>
              {percent(analysis.benchmark.cacheHitRate)} cache hit rate
            </span>
          </div>
        </section>

        <CodePanel
          file={selectedFile}
          importEdges={selectedImports}
          importedByEdges={selectedImportedBy}
          functions={selectedFunctions}
          onNavigate={selectFile}
          onOpenSource={openSource}
          onFocusRelated={focusRelated}
        />
      </div>

      <section className="aa-benchmark-panel">
        <div>
          <p className="aa-eyebrow">MEASUREMENTS</p>
          <h2>Benchmark</h2>
        </div>

        <div className="aa-benchmark-metric">
          <span>Fetch / load</span>
          <strong>
            {analysis.benchmark.fetchMs == null
              ? "—"
              : `${analysis.benchmark.fetchMs} ms`}
          </strong>
        </div>

        <div className="aa-benchmark-metric">
          <span>Parse</span>
          <strong>
            {analysis.benchmark.parseMs == null
              ? "—"
              : `${analysis.benchmark.parseMs} ms`}
          </strong>
        </div>

        <div className="aa-benchmark-metric">
          <span>Graph analysis</span>
          <strong>
            {analysis.benchmark.graphMs == null
              ? "—"
              : `${analysis.benchmark.graphMs} ms`}
          </strong>
        </div>

        <div className="aa-benchmark-metric">
          <span>Layout</span>
          <strong>
            {analysis.benchmark.layoutMs == null
              ? "Measuring"
              : `${analysis.benchmark.layoutMs} ms`}
          </strong>
        </div>

        <div className="aa-benchmark-metric">
          <span>Frame loop</span>
          <strong>
            {analysis.benchmark.fps == null
              ? "Measuring"
              : `${analysis.benchmark.fps} FPS`}
          </strong>
        </div>

        <button
          type="button"
          className="aa-button aa-button-secondary"
          onClick={exportBenchmark}
        >
          Download JSON
        </button>
      </section>

      <footer className="aa-workspace-footer">
        <span>Astral Atlas · Browser-first repository intelligence</span>
        <span>Source files are analysed in your browser.</span>
      </footer>

      {sourceScreenOpen && (
        <Suspense
          fallback={
            <section
              className="aa-source-screen aa-source-opening"
              role="status"
            >
              <p className="aa-eyebrow">SOURCE EXPLORER</p>
              <h1>Opening the file…</h1>
              <p>Preparing the full-screen source view.</p>
            </section>
          }
        >
          <SourceExplorer
            model={selectedSourceModel}
            source={source}
            loading={sourceLoading}
            sourceError={sourceError}
            initialLine={jumpToLine}
            onBack={handleSourceBack}
            onNavigate={(path) => openSource(path, 1)}
            onJumpToLine={setJumpToLine}
            onRetry={handleSourceRetry}
          />
        </Suspense>
      )}
    </main>
  );
}