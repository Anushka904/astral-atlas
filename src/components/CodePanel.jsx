/**
 * Compact graph file inspector.
 *
 * Navigation rule:
 * - Related-file links select/focus nodes in the existing graph.
 * - The neighbourhood action zooms to the selected node and one-hop
 *   import relationships.
 * - Only the explicit source action opens Source Explorer.
 */

import React from "react";

export default function CodePanel({
  file,
  importEdges = [],
  importedByEdges = [],
  functions = [],
  onNavigate,
  onOpenSource,
  onFocusRelated
}) {
  if (!file) {
    return (
      <aside className="aa-code-panel aa-code-panel-empty">
        <div className="aa-code-heading">
          <p className="aa-eyebrow">FILE INSPECTOR</p>
          <h2>Select a file</h2>
        </div>

        <p className="aa-muted-text">
          Select a file in the atlas or file index to inspect its
          dependencies. You can explore its neighbourhood or open
          its source separately.
        </p>
      </aside>
    );
  }

  return (
    <aside className="aa-code-panel aa-file-inspector">
      <div className="aa-code-heading">
        <p className="aa-eyebrow">FILE INSPECTOR</p>
        <h2 title={file.path}>{file.label ?? file.path}</h2>
        <p className="aa-code-path">{file.path}</p>

        {file.parseStatus === "error" && (
          <div className="aa-inline-error" role="status">
            <strong>Parsing failed</strong>
            <p>
              {file.warning ??
                "Source metrics may be unavailable for this file."}
            </p>
          </div>
        )}

        {file.parseStatus === "recovered" && (
          <div className="aa-inline-warning" role="status">
            <strong>Partial analysis</strong>
            <p>
              Some syntax issues were recovered during parsing.
            </p>
          </div>
        )}
      </div>

      <div className="aa-code-metrics">
        <div>
          <span>Lines</span>
          <strong>{file.loc ?? 0}</strong>
        </div>

        <div>
          <span>Tokens</span>
          <strong>{file.tokenCount ?? 0}</strong>
        </div>

        <div>
          <span>Complexity</span>
          <strong>{file.cyclomaticComplexity ?? 0}</strong>
        </div>
      </div>

      <div className="aa-file-inspector-actions">
        <button
          type="button"
          className="aa-button aa-button-secondary"
          onClick={() => onFocusRelated?.(file.path)}
          title="Focus this file and its direct importers and dependencies"
        >
          <span aria-hidden="true">◎</span>
          Focus dependency neighbourhood
        </button>

        <button
          type="button"
          className="aa-button aa-button-primary"
          onClick={() => onOpenSource?.(file.path, 1)}
        >
          <span aria-hidden="true">{"</>"}</span>
          Open full-screen source
        </button>
      </div>

      <section className="aa-code-section">
        <h3>Imports ({importEdges.length})</h3>

        {importEdges.length === 0 ? (
          <p className="aa-muted-text">
            No resolved internal imports.
          </p>
        ) : (
          <ul className="aa-link-list">
            {importEdges.map((edge) => (
              <li
                key={
                  edge.id ??
                  `${edge.source}->${edge.target}`
                }
              >
                <button
                  type="button"
                  onClick={() => onNavigate?.(edge.target)}
                  title={`Select ${edge.target} in the graph`}
                >
                  <span>{edge.target}</span>
                  <span aria-hidden="true">◎</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aa-code-section">
        <h3>Imported by ({importedByEdges.length})</h3>

        {importedByEdges.length === 0 ? (
          <p className="aa-muted-text">
            No resolved internal dependents.
          </p>
        ) : (
          <ul className="aa-link-list">
            {importedByEdges.map((edge) => (
              <li
                key={
                  edge.id ??
                  `${edge.source}->${edge.target}`
                }
              >
                <button
                  type="button"
                  onClick={() => onNavigate?.(edge.source)}
                  title={`Select ${edge.source} in the graph`}
                >
                  <span>{edge.source}</span>
                  <span aria-hidden="true">◎</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aa-code-section">
        <h3>Functions ({functions.length})</h3>

        {functions.length === 0 ? (
          <p className="aa-muted-text">
            No functions were extracted from this file.
          </p>
        ) : (
          <ul className="aa-function-list">
            {functions.map((fn) => (
              <li key={fn.id}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenSource?.(file.path, fn.startLine)
                  }
                  title={`Open source at line ${fn.startLine}`}
                >
                  <span className="aa-function-name">
                    {fn.name}
                  </span>

                  <span className="aa-function-meta">
                    L{fn.startLine} · C{fn.cyclomaticComplexity}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="aa-file-inspector-hint">
        Selecting a related file stays in the Atlas. Open source only
        when you choose the source action.
      </p>
    </aside>
  );
}