/**
 * Repository-analysis progress view.
 *
 * WHY: A repository can take time to fetch and parse. The user should know
 * which stage is active instead of seeing an unexplained loading spinner.
 */

import React from "react";

const STEPS = [
  {
    id: "listing",
    label: "Listing files",
    description: "Validating the repository and retrieving its tree."
  },
  {
    id: "reading-config",
    label: "Reading configuration",
    description: "Loading tsconfig/jsconfig path aliases."
  },
  {
    id: "checking-cache",
    label: "Checking cache",
    description: "Reusing summaries for unchanged source files."
  },
  {
    id: "downloading",
    label: "Downloading",
    description: "Fetching source files not found in the cache."
  },
  {
    id: "parsing",
    label: "Parsing ASTs",
    description: "Extracting functions and dependencies in Web Workers."
  },
  {
    id: "building-graph",
    label: "Building the graph",
    description: "Resolving imports, calls, cycles and impact."
  },
  {
    id: "laying-out",
    label: "Preparing the atlas",
    description: "Positioning graph nodes for interactive exploration."
  }
];

const STAGE_INDEX = new Map(
  STEPS.map((step, index) => [step.id, index])
);

/**
 * @param {{
 *   state:object,
 *   onCancel:()=>void
 * }} props
 */
export default function AnalysisProgress({
  state,
  onCancel
}) {
  const currentStage =
    state.stage === "filtering"
      ? "listing"
      : state.stage;

  const currentIndex =
    STAGE_INDEX.get(currentStage) ?? 0;

  const progress = state.progress;
  const hasCounts =
    Number.isFinite(progress?.total) &&
    progress.total > 0;

  const progressPercent = hasCounts
    ? Math.min(
        100,
        Math.round((progress.done / progress.total) * 100)
      )
    : null;

  return (
    <main className="aa-progress-page">
      <div className="aa-progress-orb" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className="aa-progress-heading">
        <p className="aa-eyebrow">
          ASTRAL ATLAS / CARTOGRAPHY IN PROGRESS
        </p>

        <h1>Tracing the repository.</h1>

        <p className="aa-progress-message" role="status" aria-live="polite">
          {state.message || "Preparing the analysis pipeline."}
        </p>

        {state.progress?.currentFile && (
          <p className="aa-current-file">
            Current file:{" "}
            <code>{state.progress.currentFile}</code>
          </p>
        )}
      </div>

      <section
        className="aa-timeline"
        aria-label="Repository analysis progress"
      >
        {STEPS.map((step, index) => {
          const completed = index < currentIndex;
          const active = index === currentIndex;

          const status = completed
            ? "complete"
            : active
              ? "active"
              : "pending";

          return (
            <div
              className={`aa-timeline-step aa-step-${status}`}
              key={step.id}
              aria-current={active ? "step" : undefined}
            >
              <div className="aa-step-marker" aria-hidden="true">
                {completed ? "✓" : String(index + 1).padStart(2, "0")}
              </div>

              <div className="aa-step-copy">
                <strong>{step.label}</strong>
                <p>{step.description}</p>

                {active && hasCounts && (
                  <div className="aa-progress-counts">
                    <div className="aa-progress-track">
                      <div
                        className="aa-progress-fill"
                        style={{
                          width: `${progressPercent}%`
                        }}
                      />
                    </div>

                    <span>
                      {progress.done.toLocaleString()} /{" "}
                      {progress.total.toLocaleString()}{" "}
                      {progress.phase === "parsing"
                        ? "files processed"
                        : "items processed"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {state.error && (
        <div className="aa-inline-error" role="alert">
          <strong>Analysis stopped</strong>
          <p>{state.error.message}</p>
        </div>
      )}

      <div className="aa-progress-actions">
        <button
          className="aa-button aa-button-secondary"
          onClick={onCancel}
          type="button"
        >
          Cancel analysis
        </button>
      </div>

      <p className="aa-privacy-note">
        Parsing runs in your browser. Source files are not sent to an AI
        service by this analysis pipeline.
      </p>
    </main>
  );
}