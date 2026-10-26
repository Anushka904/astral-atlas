/**
 * Read-only CodeMirror editor for JavaScript, JSX, TypeScript and TSX.
 *
 * WHY:
 * Loading CodeMirror dynamically keeps the editor's dependency graph out
 * of the initial landing-page bundle.
 *
 * Source code is displayed read-only. The component never sends source text
 * to an external service.
 */

import React, { useEffect, useRef, useState } from "react";

import "./source-explorer.css";

/**
 * @param {{
 *   path:string,
 *   source:string,
 *   initialLine?:number,
 *   onError?:(message:string)=>void
 * }} props
 */
export default function ReadOnlyCodeEditor({
  path,
  source,
  initialLine = 1,
  onError
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const sourceRef = useRef(source);
  const initialLineRef = useRef(initialLine);
  const onErrorRef = useRef(onError);

  const [editorState, setEditorState] = useState("loading");

  sourceRef.current = source;
  initialLineRef.current = initialLine;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let createdView = null;

    setEditorState("loading");

    async function createEditor() {
      try {
        const [
          { EditorState },
          { EditorView },
          { javascript }
        ] = await Promise.all([
          import("@codemirror/state"),
          import("@codemirror/view"),
          import("@codemirror/lang-javascript")
        ]);

        if (cancelled || !hostRef.current) {
          return;
        }

        const extension = path
          .toLowerCase()
          .match(/\.[^./\\]+$/)?.[0] ?? ".js";

        const language = javascript({
          jsx: [".jsx", ".tsx"].includes(extension),
          typescript: [".ts", ".tsx"].includes(extension)
        });

        const theme = EditorView.theme(
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
              lineHeight: "1.75"
            },
            ".cm-content": {
              padding: "20px 0"
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
            ".cm-selectionBackground": {
              backgroundColor: "rgba(102, 187, 106, 0.24)"
            },
            ".cm-cursor": {
              display: "none"
            }
          },
          { dark: true }
        );

        const state = EditorState.create({
          doc: sourceRef.current ?? "",
          extensions: [
            language,
            theme,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.lineWrapping
          ]
        });

        createdView = new EditorView({
          state,
          parent: hostRef.current
        });

        viewRef.current = createdView;

        if (cancelled) {
          createdView.destroy();
          return;
        }

        setEditorState("ready");

        scrollToLine(
          createdView,
          EditorView,
          initialLineRef.current
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error?.message ??
          "The source editor could not be loaded.";

        setEditorState("error");
        onErrorRef.current?.(message);

        console.error("Could not initialize CodeMirror.", error);
      }
    }

    void createEditor();

    return () => {
      cancelled = true;

      if (createdView) {
        createdView.destroy();
      }

      if (viewRef.current === createdView) {
        viewRef.current = null;
      }
    };
  }, [path]);

  // Update the document if the source arrives after the editor's modules load.
  useEffect(() => {
    const view = viewRef.current;

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
  }, [source]);

  // Support clicking a function entry to scroll to its source line.
  useEffect(() => {
    const view = viewRef.current;

    if (!view) {
      return;
    }

    import("@codemirror/view")
      .then(({ EditorView }) => {
        if (view.destroyed) {
          return;
        }

        scrollToLine(view, EditorView, initialLine);
      })
      .catch((error) => {
        onErrorRef.current?.(
          error?.message ??
            "Could not navigate to the requested source line."
        );
      });
  }, [initialLine]);

  return (
    <div className="aa-readonly-editor">
      {editorState === "loading" && (
        <div className="aa-source-loading" role="status">
          Loading read-only source viewer…
        </div>
      )}

      {editorState === "error" && (
        <div className="aa-source-editor-error" role="alert">
          The source editor failed to initialize. Return to the Atlas and
          reopen this file, or check the browser console for details.
        </div>
      )}

      <div
        className="aa-readonly-editor-host"
        ref={hostRef}
        aria-label={`Read-only source code: ${path}`}
      />
    </div>
  );
}

/**
 * Scroll to a valid source line.
 *
 * @param {object} view CodeMirror EditorView
 * @param {object} EditorView CodeMirror EditorView constructor
 * @param {number} lineNumber
 */
function scrollToLine(view, EditorView, lineNumber) {
  if (!view || view.destroyed || !Number.isFinite(lineNumber)) {
    return;
  }

  const safeLine = Math.min(
    Math.max(1, Math.floor(lineNumber)),
    view.state.doc.lines
  );

  const position = view.state.doc.line(safeLine).from;

  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, {
      y: "center"
    })
  });
}