/**
 * Astral Atlas application entry.
 *
 * The landing page is the initial experience.
 * Repository analysis is coordinated by AppController.
 * The graph workspace is lazy-loaded after repository analysis completes.
 *
 * Product branding is kept independent of hackathon/event labels.
 */

import React, {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState
} from "react";

import AppController from "./engine/AppController.js";

import Starfield from "./components/Starfield.jsx";
import AnalysisProgress from "./components/AnalysisProgress.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import LandingMotion from "./components/LandingMotion.jsx";
import ArchitecturePreview from "./components/ArchitecturePreview.jsx";

import "./styles/landing.css";
import "./styles/atlas.css";
import "./styles/landing-interactions.css";

const AtlasWorkspace = lazy(
  () => import("./components/AtlasWorkspace.jsx")
);

const INITIAL_STATE = {
  phase: "idle",
  isRunning: false,
  stage: null,
  message: "",
  progress: null,
  error: null,
  result: null,
  benchmark: {
    fetchMs: null,
    parseMs: null,
    graphMs: null,
    layoutMs: null,
    cacheHitRate: null,
    cacheHits: null,
    cacheMisses: null,
    fps: null
  }
};

const SAMPLE_REPOSITORIES = [
  {
    owner: "sindresorhus",
    repo: "p-limit",
    size: "Small",
    description:
      "A compact utility for limiting concurrent promise execution."
  },
  {
    owner: "expressjs",
    repo: "express",
    size: "Medium",
    description:
      "A widely used web framework with meaningful module relationships."
  },
  {
    owner: "axios",
    repo: "axios",
    size: "Medium",
    description:
      "An HTTP client with adapters, utilities, and a modular source tree."
  }
];

function isValidRepoQuery(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function makeGitHubUrl(value) {
  const trimmed = value.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (isValidRepoQuery(trimmed)) {
    return `https://github.com/${trimmed}`;
  }

  return trimmed;
}

function WorkspaceLoading() {
  return (
    <main className="aa-workspace-opening" role="status">
      <span
        className="aa-workspace-opening-mark"
        aria-hidden="true"
      >
        ✳
      </span>

      <p className="aa-eyebrow">ASTRAL ATLAS</p>

      <h1>Preparing your atlas.</h1>

      <p>Loading the interactive graph workspace.</p>
    </main>
  );
}

function AppContent() {
  const controllerRef = useRef(null);
  const zipInputRef = useRef(null);

  const [state, setState] = useState(INITIAL_STATE);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let active = true;

    const controller = new AppController({
      onUpdate(nextState) {
        if (active) {
          setState(nextState);
        }
      }
    });

    controllerRef.current = controller;

    // Automatically analyse a repository supplied through ?repo=owner/name.
    const params = new URLSearchParams(window.location.search);
    const sharedRepo = params.get("repo");

    if (sharedRepo && isValidRepoQuery(sharedRepo)) {
      const url = `https://github.com/${sharedRepo}`;

      setRepositoryInput(url);

      void controller.analyzeGitHub(url).catch(() => {
        // AppController publishes the user-facing error state.
      });
    }

    return () => {
      active = false;
      controller.destroy();

      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, []);

  async function startGitHubAnalysis(value = repositoryInput) {
    const controller = controllerRef.current;

    if (!controller || controller.getState().isRunning) {
      return;
    }

    const input = makeGitHubUrl(value);

    setRepositoryInput(input);
    setAnnouncement("Repository analysis started.");

    try {
      await controller.analyzeGitHub(input, {
        token: tokenInput
      });
    } catch {
      // AppController publishes the actual error to the interface.
    }
  }

  async function startZipAnalysis(file) {
    const controller = controllerRef.current;

    if (!file || !controller || controller.getState().isRunning) {
      return;
    }

    setAnnouncement(`Preparing ${file.name}.`);

    try {
      await controller.analyzeZip(file);
    } catch {
      // AppController publishes the actual error to the interface.
    }
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (!repositoryInput.trim()) {
      setAnnouncement(
        "Enter a public GitHub repository URL first."
      );
      return;
    }

    void startGitHubAnalysis();
  }

  function handleZipChange(event) {
    const file = event.target.files?.[0];

    if (file) {
      void startZipAnalysis(file);
    }

    // Allow the same archive to be selected again after a failed attempt.
    event.target.value = "";
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (!file) {
      return;
    }

    if (!/\.zip$/i.test(file.name)) {
      setAnnouncement("Choose a file ending in .zip.");
      return;
    }

    void startZipAnalysis(file);
  }

  function returnHome() {
    controllerRef.current?.reset();

    setRepositoryInput("");
    setTokenInput("");
    setAnnouncement("Ready for another repository.");

    const url = new URL(window.location.href);
    url.searchParams.delete("repo");

    window.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }

  if (state.isRunning) {
    return (
      <div className="aa-app-root">
        <AnalysisProgress
          state={state}
          onCancel={() => controllerRef.current?.cancel()}
        />
      </div>
    );
  }

  if (state.phase === "complete" && state.result) {
    return (
      <div className="aa-app-root">
        <Suspense fallback={<WorkspaceLoading />}>
          <AtlasWorkspace
            analysis={state.result}
            controller={controllerRef.current}
            onBack={returnHome}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="aa-app-root aa-landing-page">
      <div className="aa-landing-stars" aria-hidden="true">
        <Starfield />
      </div>

      <LandingMotion />

      <header className="aa-landing-header">
        <a
          className="aa-brand"
          href="#top"
          aria-label="Astral Atlas home"
        >
          <div className="aa-brand-mark" aria-hidden="true">
            ✳
          </div>

          <div>
            <strong>
              Astral <span>Atlas</span>
            </strong>

            <span>Repository cartography</span>
          </div>
        </a>

        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
          <span className="aa-browser-first">BROWSER-FIRST</span>
        </nav>
      </header>

      <main id="top" className="aa-landing-content">
        <div className="aa-hero">
          <h1>
            Navigate the architecture
            <span> hidden in your code.</span>
          </h1>

          <p className="aa-hero-description">
            Turn an unfamiliar JavaScript or TypeScript repository into
            an interactive map of its modules, functions, dependencies,
            and hidden circular paths.
          </p>

          <div className="aa-hero-actions">
            <a className="aa-hero-cta" href="#repository-start">
              Start mapping a repository{" "}
              <span aria-hidden="true">→</span>
            </a>

            <a className="aa-hero-secondary" href="#how-it-works">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>

          {state.error && (
            <div
              className="aa-inline-error aa-landing-error"
              role="alert"
            >
              <strong>
                {state.error.code === "GITHUB_RATE_LIMITED"
                  ? "GitHub access was restricted"
                  : state.error.code === "NO_SOURCE_FILES"
                    ? "No supported source files found"
                    : "The repository could not be analysed"}
              </strong>

              <p>{state.error.message}</p>

              {state.error.code === "GITHUB_RATE_LIMITED" && (
                <p>
                  Try again later, configure Atlas Edge, or use an optional
                  GitHub token in the field below. You can also upload a
                  ZIP archive instead.
                </p>
              )}
            </div>
          )}

          <section
            id="repository-start"
            className="aa-input-card"
            aria-label="Choose a repository"
          >
            <div className="aa-input-heading">
              <strong>Plot your first repository</strong>
              <span>JavaScript / TypeScript</span>
            </div>

            <form
              className="aa-repository-form"
              onSubmit={handleSubmit}
            >
              <label
                className="aa-visually-hidden"
                htmlFor="aa-repository-url"
              >
                Public GitHub repository URL
              </label>

              <div className="aa-repository-input-wrap">
                <span aria-hidden="true">⌘</span>

                <input
                  id="aa-repository-url"
                  type="url"
                  inputMode="url"
                  value={repositoryInput}
                  onChange={(event) =>
                    setRepositoryInput(event.target.value)
                  }
                  placeholder="https://github.com/owner/repository"
                  autoComplete="url"
                  spellCheck="false"
                />
              </div>

              <button
                type="submit"
                className="aa-button aa-button-primary aa-analyze-button"
                disabled={state.isRunning}
              >
                Chart repository <span aria-hidden="true">→</span>
              </button>
            </form>

            <details className="aa-token-details">
              <summary>
                Rate-limit fallback: optional GitHub token
              </summary>

              <label htmlFor="aa-github-token">
                Personal access token (kept in memory only)
              </label>

              <input
                id="aa-github-token"
                type="password"
                value={tokenInput}
                onChange={(event) =>
                  setTokenInput(event.target.value)
                }
                autoComplete="off"
                spellCheck="false"
                placeholder="Paste a token only if needed"
              />

              <p>
                The token isn't written to local storage or the repository.
                Use the minimum access required for public repository
                reading. Never paste a token into a repository URL.
              </p>
            </details>

            <div
              className={`aa-dropzone ${
                dragActive ? "aa-dropzone-active" : ""
              }`}
              role="button"
              tabIndex={0}
              aria-label="Select a ZIP archive"
              onClick={() => zipInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  zipInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setDragActive(false);
                }
              }}
              onDrop={handleDrop}
            >
              <span className="aa-dropzone-icon" aria-hidden="true">
                ⇧
              </span>

              <span>
                <strong>Or drop a ZIP archive here</strong>

                <small>
                  Up to 50 MB compressed · analysis stays in your browser
                </small>
              </span>

              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                className="aa-visually-hidden"
                onChange={handleZipChange}
              />
            </div>

            <p className="aa-privacy-note" id="privacy">
              <span aria-hidden="true">◈</span>
              Your source code is fetched and parsed in your browser.
              Atlas Edge relays limited metadata requests only; it doesn't
              relay source files.
            </p>
          </section>
        </div>

        <ArchitecturePreview />

        <section className="aa-samples-section">
          <div className="aa-section-heading">
            <div>
              <p className="aa-eyebrow">
                START WITH A KNOWN REPOSITORY
              </p>

              <h2>Choose a starting constellation.</h2>
            </div>

            <span>Public GitHub projects</span>
          </div>

          <div className="aa-sample-grid">
            {SAMPLE_REPOSITORIES.map((sample) => {
              const fullName = `${sample.owner}/${sample.repo}`;

              return (
                <button
                  type="button"
                  className="aa-sample-card"
                  key={fullName}
                  onClick={() =>
                    void startGitHubAnalysis(
                      `https://github.com/${fullName}`
                    )
                  }
                >
                  <span className="aa-sample-title">
                    {fullName}
                    <span aria-hidden="true">↗</span>
                  </span>

                  <span className="aa-sample-description">
                    {sample.description}
                  </span>

                  <span className="aa-sample-meta">
                    <span aria-hidden="true">◎</span>
                    Explore sample · {sample.size}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="aa-how-section"
          id="how-it-works"
        >
          <div className="aa-how-heading">
            <p className="aa-eyebrow">
              FROM CODEBASE TO CONSTELLATION
            </p>

            <h2>Every repository has a shape.</h2>

            <p>
              Understand an unfamiliar project before deciding where
              to change it.
            </p>
          </div>

          <div className="aa-how-grid">
            <article className="aa-how-card">
              <span>STAGE 01</span>
              <h3>Choose your repository</h3>
              <p>
                Paste a public GitHub URL or bring a ZIP archive from
                your computer.
              </p>
            </article>

            <article className="aa-how-card">
              <span>STAGE 02</span>
              <h3>Trace its architecture</h3>
              <p>
                Extract source structure, dependencies, functions, and
                code-health signals in your browser.
              </p>
            </article>

            <article className="aa-how-card">
              <span>STAGE 03</span>
              <h3>Find your way through</h3>
              <p>
                Explore the dependency atlas, investigate circular paths,
                and discover lower-impact files to start with.
              </p>
            </article>
          </div>
        </section>

        <section className="aa-privacy-section">
          <span className="aa-privacy-seal" aria-hidden="true">
            ◈
          </span>

          <div>
            <h2>Built for curious engineers.</h2>

            <p>
              The source parser operates in browser workers. The optional
              Edge service relays selected GitHub metadata requests; it
              isn't a source-code upload service.
            </p>
          </div>
        </section>
      </main>

      <footer className="aa-landing-footer">
        <span>Astral Atlas · Browser-first repository intelligence</span>
        <span>
          Mapping dependencies, not sending source code to an AI service.
        </span>
      </footer>

      <p
        className="aa-visually-hidden"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </p>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}