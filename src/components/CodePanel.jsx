/**
 * Read-only source exploration panel.
 *
 * All colours reference Astral Atlas CSS variables so the editor follows the
 * same palette as the landing page and graph.
 */

import React, { useEffect, useRef } from "react";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--aa-code-bg)",
      color: "var(--aa-parchment)",
      fontSize: "12px"
    },

    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"JetBrains Mono", monospace',
      lineHeight: "1.7"
    },

    ".cm-content": {
      padding: "14px 0"
    },

    ".cm-gutters": {
      backgroundColor: "var(--aa-panel)",
      color: "var(--aa-muted)",
      borderRight: "1px solid var(--aa-border)"
    },

    ".cm-activeLine": {
      backgroundColor: "var(--aa-raised)"
    },

    ".cm-activeLineGutter": {
      backgroundColor: "var(--aa-raised)"
    },

    ".cm-cursor": {
      display: "none"
    },

    ".cm-selectionBackground": {
      backgroundColor: "rgba(102, 187, 106, 0.24)"
    }
  },
  { dark: true }
);

/**
 * @param {{
 *   file:object|null,
 *   source:string|null,
 *   loading?:boolean,
 *   sourceError?:string|null,
 *   importEdges?:object[],
 *   importedByEdges?:object[],
 *   functions?:object[],
 *   onNavigate?:(path:string)=>void
 * }} props
 */
export default function CodePanel({
  file,
  source,
  loading = false,
  sourceError = null,
  importEdges = [],
  importedByEdges = [],
  functions = [],
  onNavigate
}) {
  const editorHostRef = useRef(null);
  const editorViewRef = useRef(null);

  useEffect(() => {
    if (!editorHostRef.current || !file) {
      return undefined;
    }

    const path = file.path ?? "";
    const extension =
      path.match(/\.[^./\\]+$/)?.[0]?.toLowerCase();

    const language = javascript({
      jsx: extension === ".jsx" || extension === ".tsx",
      typescript: extension === ".ts" || extension === ".tsx"
    });

    const state = EditorState.create({
      doc: source ?? "",
      extensions: [
        language,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        editorTheme
      ]
    });

    const view = new EditorView({
      state,
      parent: editorHostRef.current
    });

    editorViewRef.current = view;

    return () => {
      view.destroy();

      if (editorViewRef.current === view) {
        editorViewRef.current = null;
      }
    };
  }, [file?.path]);

  useEffect(() => {
    const view = editorViewRef.current;

    if (!view || typeof source !== "string") {
      return;
    }

    const currentText = view.state.doc.toString();

    if (currentText !== source) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: source
        }
      });
    }
  }, [source, file?.path]);

  function scrollToLine(lineNumber) {
    const view = editorViewRef.current;

    if (!view || !Number.isFinite(lineNumber)) {
      return;
    }

    const safeLine = Math.min(
      Math.max(1, Math.floor(lineNumber)),
      view.state.doc.lines
    );

    const position = view.state.doc.line(safeLine).from;

    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(
        position,
        { y: "start" }
      )
    });

    view.focus();
  }

  if (!file) {
    return (
      <aside className="aa-code-panel aa-code-panel-empty">
        <div className="aa-panel-heading">
          <p className="aa-eyebrow">SOURCE EXPLORER</p>
          <h2>Select a file</h2>
        </div>

        <p>
          Choose a file from the graph or file index to inspect its code
          and metrics.
        </p>
      </aside>
    );
  }

  return (
    <aside className="aa-code-panel">
      <div className="aa-code-heading">
        <p className="aa-eyebrow">SOURCE EXPLORER</p>
        <h2 title={file.path}>{file.label}</h2>
        <p className="aa-code-path">{file.path}</p>

        {file.parseStatus === "error" && (
          <div className="aa-inline-error" role="status">
            <strong>Parsing failed</strong>
            <p>
              {file.warning ??
                "This file couldn't be parsed."}
            </p>
          </div>
        )}

        {file.parseStatus === "recovered" && (
          <div className="aa-inline-warning" role="status">
            <strong>Partial analysis</strong>
            <p>
              {file.warning ??
                "The parser recovered from a syntax issue."}
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

      <section className="aa-code-section">
        <h3>Imports</h3>

        {importEdges.length === 0 ? (
          <p className="aa-muted-text">
            No internal imports found.
          </p>
        ) : (
          <ul className="aa-link-list">
            {importEdges.map((edge) => (
              <li key={edge.id}>
                <button
                  type="button"
                  onClick={() => onNavigate?.(edge.target)}
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

      <section className="aa-code-section">
        <h3>Imported by</h3>

        {importedByEdges.length === 0 ? (
          <p className="aa-muted-text">
            No other analysed files import this file.
          </p>
        ) : (
          <ul className="aa-link-list">
            {importedByEdges.map((edge) => (
              <li key={edge.id}>
                <button
                  type="button"
                  onClick={() => onNavigate?.(edge.source)}
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
                  onClick={() => scrollToLine(fn.startLine)}
                  title={`Jump to line ${fn.startLine}`}
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

      <div className="aa-editor-heading">
        <span>Source</span>
        {loading && (
          <span className="aa-loading-indicator">
            Loading…
          </span>
        )}
      </div>

      {sourceError && (
        <div className="aa-inline-error" role="alert">
          {sourceError}
        </div>
      )}

      {loading && source === null ? (
        <div className="aa-editor-empty" role="status">
          <span className="aa-skeleton-line" />
          <span className="aa-skeleton-line" />
          <span className="aa-skeleton-line" />
        </div>
      ) : source === null ? (
        <div className="aa-editor-empty">
          <p>Source code is unavailable.</p>
        </div>
      ) : (
        <div
          className="aa-code-editor"
          ref={editorHostRef}
          aria-label="Read-only source code editor"
        />
      )}
    </aside>
  );
}