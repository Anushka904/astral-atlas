/**
 * Full-screen read-only source browser.
 *
 * This component is lazy-loaded by AtlasWorkspace. Its CodeMirror editor is
 * another lazy-loaded module, so the initial landing page doesn't need to
 * download the code editor.
 */

import React, { Suspense, lazy } from "react";

import "./source-explorer.css";

const ReadOnlyCodeEditor = lazy(
  () => import("./ReadOnlyCodeEditor.jsx")
);

/**
 * @param {{
 *   model:object,
 *   source:string|null,
 *   loading?:boolean,
 *   sourceError?:string|null,
 *   initialLine?:number,
 *   onBack:()=>void,
 *   onNavigate:(path:string)=>void,
 *   onJumpToLine:(line:number)=>void,
 *   onRetry:()=>void
 * }} props
 */
export default function SourceExplorer({
  model,
  source,
  loading = false,
  sourceError = null,
  initialLine = 1,
  onBack,
  onNavigate,
  onJumpToLine,
  onRetry
}) {
  if (!model) {
    return (
      <section
        className="aa-source-screen"
        role="dialog"
        aria-modal="true"
        aria-label="Source Explorer"
      >
        <header className="aa-source-header">
          <button
            className="aa-source-back"
            onClick={onBack}
            type="button"
          >
            <span aria-hidden="true">←</span>
            Back to Atlas
          </button>
        </header>

        <div className="aa-source-empty">
          <h1>File unavailable</h1>
          <p>
            The selected file is no longer available in the current
            repository analysis.
          </p>
        </div>
      </section>
    );
  }

  const { file, imports, importedBy, functions, metrics } = model;

  return (
    <section
      className="aa-source-screen"
      role="dialog"
      aria-modal="true"
      aria-label={`Source Explorer for ${file.path}`}
    >
      <header className="aa-source-header">
        <div className="aa-source-header-main">
          <button
            className="aa-source-back"
            onClick={onBack}
            type="button"
          >
            <span aria-hidden="true">←</span>
            Back to Atlas
          </button>

          <div className="aa-source-breadcrumb">
            <span>Astral Atlas</span>
            <span aria-hidden="true">/</span>
            <span>Source Explorer</span>
          </div>
        </div>

        <div className="aa-source-file-identity">
          <div className="aa-source-file-icon" aria-hidden="true">
            {"</>"}
          </div>

          <div>
            <h1 title={file.path}>{file.label ?? file.path}</h1>
            <p title={file.path}>{file.path}</p>
          </div>
        </div>

        <div className="aa-source-header-actions">
          <span className="aa-source-readonly-label">
            READ ONLY
          </span>

          <button
            className="aa-source-back aa-source-close"
            onClick={onBack}
            type="button"
          >
            Close <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div className="aa-source-body">
        <main className="aa-source-editor-column">
          <div className="aa-source-code-toolbar">
            <div>
              <span className="aa-source-toolbar-dot" />
              <strong>Source code</strong>
              <span className="aa-source-language-label">
                {file.path.split(".").pop()?.toUpperCase() ?? "SOURCE"}
              </span>
            </div>

            {functions.length > 0 && (
              <label className="aa-source-function-jump">
                <span>Jump to function</span>

                <select
                  value=""
                  onChange={(event) => {
                    const fn = functions.find(
                      (item) => item.id === event.target.value
                    );

                    if (fn) {
                      onJumpToLine(fn.startLine);
                    }
                  }}
                >
                  <option value="">Choose a function…</option>

                  {functions.map((fn) => (
                    <option
                      key={fn.id}
                      value={fn.id}
                    >
                      {fn.name} · line {fn.startLine}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {file.parseStatus === "error" && (
            <div className="aa-source-file-warning" role="status">
              <strong>AST parsing failed for this file.</strong>
              <p>
                The source can still be viewed, but metrics and extracted
                functions may be incomplete.{" "}
                {file.warning ?? ""}
              </p>
            </div>
          )}

          {file.parseStatus === "recovered" && (
            <div className="aa-source-file-warning" role="status">
              <strong>Partial AST analysis</strong>
              <p>
                Babel recovered from one or more syntax issues. Treat the
                extracted metrics and relationships as partial.
              </p>
            </div>
          )}

          {sourceError && (
            <div className="aa-source-file-error" role="alert">
              <strong>Source code could not be loaded.</strong>
              <p>{sourceError}</p>

              <button
                className="aa-button aa-button-secondary"
                onClick={onRetry}
                type="button"
              >
                Retry loading
              </button>
            </div>
          )}

          {loading && source === null ? (
            <div className="aa-source-editor-placeholder" role="status">
              <div className="aa-source-loading-orb" />
              <strong>Opening source code</strong>
              <p>Retrieving the selected file into your browser.</p>

              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : source === null ? (
            <div className="aa-source-editor-placeholder">
              <strong>Source unavailable</strong>
              <p>
                Check the network request or try reloading the file.
              </p>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="aa-source-editor-placeholder" role="status">
                  Loading the syntax-highlighting editor…
                </div>
              }
            >
              <ReadOnlyCodeEditor
                path={file.path}
                source={source}
                initialLine={initialLine}
                onError={(message) => {
                  console.error("Source viewer error:", message);
                }}
              />
            </Suspense>
          )}

          <div className="aa-source-editor-footer">
            <span>Read-only · Source stays in your browser</span>
            <span>
              {source === null
                ? "Waiting for source"
                : `${source.split(/\r\n|\r|\n/).length.toLocaleString()} source lines`}
            </span>
          </div>
        </main>

        <aside className="aa-source-inspector">
          <section className="aa-source-inspector-section">
            <p className="aa-eyebrow">CODE HEALTH</p>
            <h2>File metrics</h2>

            <div className="aa-source-metric-grid">
              <div>
                <span>Lines</span>
                <strong>{metrics.loc.toLocaleString()}</strong>
              </div>

              <div>
                <span>Tokens</span>
                <strong>{metrics.tokenCount.toLocaleString()}</strong>
              </div>

              <div>
                <span>Cyclomatic complexity</span>
                <strong>
                  {metrics.cyclomaticComplexity.toLocaleString()}
                </strong>
              </div>
            </div>

            {file.parseStatus === "error" && (
              <p className="aa-source-inspector-note">
                Complexity is unavailable because parsing failed.
              </p>
            )}
          </section>

          <section className="aa-source-inspector-section">
            <p className="aa-eyebrow">
              MODULE GRAPH / OUTGOING
            </p>
            <h2>Imports ({imports.length})</h2>

            {imports.length === 0 ? (
              <p className="aa-source-empty-note">
                No resolved internal imports from this file.
              </p>
            ) : (
              <ul className="aa-source-link-list">
                {imports.map((edge) => (
                  <li
                    key={
                      edge.id ??
                      `${edge.source}->${edge.target}`
                    }
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate(edge.target)}
                      title={`Open ${edge.target}`}
                    >
                      <span>{edge.target}</span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="aa-source-inspector-section">
            <p className="aa-eyebrow">
              MODULE GRAPH / INCOMING
            </p>
            <h2>Imported by ({importedBy.length})</h2>

            {importedBy.length === 0 ? (
              <p className="aa-source-empty-note">
                No resolved internal dependents.
              </p>
            ) : (
              <ul className="aa-source-link-list">
                {importedBy.map((edge) => (
                  <li
                    key={
                      edge.id ??
                      `${edge.source}->${edge.target}`
                    }
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate(edge.source)}
                      title={`Open ${edge.source}`}
                    >
                      <span>{edge.source}</span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="aa-source-inspector-section">
            <p className="aa-eyebrow">FUNCTION INDEX</p>
            <h2>Functions ({functions.length})</h2>

            {functions.length === 0 ? (
              <p className="aa-source-empty-note">
                No functions were extracted from this file.
              </p>
            ) : (
              <ul className="aa-source-function-list">
                {functions.map((fn) => (
                  <li key={fn.id}>
                    <button
                      type="button"
                      onClick={() => onJumpToLine(fn.startLine)}
                    >
                      <span className="aa-source-function-name">
                        {fn.name}
                      </span>

                      <span className="aa-source-function-meta">
                        L{fn.startLine} · C{fn.cyclomaticComplexity}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}