/**
 * Main repository-analysis workspace.
 *
 * WHY:
 * The workspace presents independent graph insights and source navigation
 * while delegating parsing and analysis to AppController.
 */

import React, {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import AtlasGraph from "./AtlasGraph.jsx";
import CodePanel from "./CodePanel.jsx";

import BlastRadiusAnalyzer from "../engine/BlastRadiusAnalyzer.js";

const numberFormat = new Intl.NumberFormat("en-US");

function Metric({ label, value }) {
  return (
    <div className="aa-summary-metric">
      <span>{label}</span>
      <strong>{numberFormat.format(value ?? 0)}</strong>
    </div>
  );
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

  const [selectedPath, setSelectedPath] = useState(
    graph.nodes.keys().next().value ?? null
  );

  const [source, setSource] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState(null);

  const [layout, setLayout] = useState("fcose");
  const [view, setView] = useState("dependencies");
  const [heatmap, setHeatmap] = useState(false);
  const [query, setQuery] = useState("");
  const [blastRadiusPaths, setBlastRadiusPaths] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const selectedFile = selectedPath
    ? graph.nodes.get(selectedPath) ?? null
    : null;

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

  const imports = graph.edges.filter(
    (edge) => edge.source === selectedPath
  );

  const importedBy = graph.edges.filter(
    (edge) => edge.target === selectedPath
  );

  const selectedFunctions = [...graph.functionNodes.values()]
    .filter((fn) => fn.filePath === selectedPath)
    .sort((a, b) => a.startLine - b.startLine);

  useEffect(() => {
    let active = true;

    if (!selectedPath) {
      setSource(null);
      setSourceError(null);
      return undefined;
    }

    setSource(null);
    setSourceError(null);
    setSourceLoading(true);

    controller.getSource(selectedPath)
      .then((text) => {
        if (active) {
          setSource(text);
        }
      })
      .catch((error) => {
        if (active) {
          setSourceError(
            error?.message ?? "Could not load this source file."
          );
        }
      })
      .finally(() => {
        if (active) {
          setSourceLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [controller, selectedPath]);

  useEffect(() => {
    function handleKeys(event) {
      const isMac =
        navigator.platform.toLowerCase().includes("mac");

      const modifier = isMac
        ? event.metaKey
        : event.ctrlKey;

      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (event.key === "Escape") {
        setQuery("");
        setShowShortcuts(false);
        return;
      }

      const tag = event.target?.tagName?.toLowerCase();

      if (
        tag === "input" ||
        tag === "textarea" ||
        event.target?.isContentEditable
      ) {
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

  function selectFile(path) {
    setSelectedPath(path);
    setBlastRadiusPaths([]);
    graphRef.current?.focusPaths([path]);
  }

  function focusCycle(cycle) {
    setBlastRadiusPaths([]);
    graphRef.current?.focusPaths(cycle.nodes);
  }

  function selectStarter(starter) {
    setSelectedPath(starter.path);

    try {
      const result = new BlastRadiusAnalyzer().analyze(
        graph,
        starter.path
      );

      setBlastRadiusPaths(
        result.impacted.map((item) => item.path)
      );

      graphRef.current?.focusPaths([starter.path]);
    } catch (error) {
      setBlastRadiusPaths([]);

      console.error(
        "Could not calculate the starter-file blast radius.",
        error
      );
    }
  }

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
          "Repository-loading phase, including tree retrieval, cache checking, configuration retrieval and downloads.",
        parseMs:
          "ParserPool duration, including parsing and cache writes.",
        graphMs:
          "Graph construction, call resolution, cycle detection and starter-file ranking.",
        layoutMs:
          "Cytoscape layout completion duration, measured in the browser.",
        fps:
          "Approximate requestAnimationFrame frequency; not a guarantee of GPU paint throughput."
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

    URL.revokeObjectURL(url);
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
          <span className="aa-eyebrow">CURRENT EXPEDITION</span>
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
        <div className="aa-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
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
          <p><kbd>Esc</kbd> Clear search or close this dialog</p>
          <p><kbd>F</kbd> Fit graph to screen</p>
          <p><kbd>1</kbd> Force-directed layout</p>
          <p><kbd>2</kbd> Hierarchical layout</p>
        </div>
      )}

      <section className="aa-summary-strip" aria-label="Repository summary">
        <Metric label="Files" value={analysis.stats.files} />
        <Metric label="Import edges" value={analysis.stats.edges} />
        <Metric label="Functions" value={analysis.stats.functions} />
        <Metric label="External packages" value={analysis.stats.externalDependencies} />
        <Metric label="Circular groups" value={analysis.cycles.cycles.length} />
        <Metric label="Orphan files" value={analysis.stats.orphanFiles} />
      </section>

      {(analysis.loaded.warnings?.length ?? 0) > 0 && (
        <section className="aa-warning-stack" aria-label="Analysis warnings">
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
          <label className="aa-visually-hidden" htmlFor="aa-file-search">
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
                    <button
                      type="button"
                      className={
                        file.path === selectedPath
                          ? "aa-file-active"
                          : ""
                      }
                      onClick={() => selectFile(file.path)}
                    >
                      <span
                        className={`aa-file-status aa-file-${file.parseStatus}`}
                        aria-hidden="true"
                      />
                      <span>{file.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {filteredFiles.length > 500 && (
              <p className="aa-muted-text">
                Showing the first 500 matching entries. Refine the search
                to narrow the list.
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

            <div className="aa-graph-legend" aria-label="Graph legend">
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
              Call edges: {analysis.callResolution.stats.resolved} resolved ·{" "}
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
          source={source}
          loading={sourceLoading}
          sourceError={sourceError}
          importEdges={imports}
          importedByEdges={importedBy}
          functions={selectedFunctions}
          onNavigate={selectFile}
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

        <div className="aa-benchmark-metric">
          <span>Functions</span>
          <strong>{analysis.stats.functions}</strong>
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
        Astral Atlas · Webster 2026 · Problem 06
        <span>Source text stays in the browser during analysis.</span>
      </footer>
    </main>
  );
}