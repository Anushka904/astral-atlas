
import { useState } from "react";

import Icon from "./Icon.jsx";
import Starfield from "./Starfield.jsx";
import UrlForm, {
  parseGithubRepoUrl
} from "./UrlForm.jsx";
import ZipDropzone from "./ZipDropzone.jsx";
import SampleRepos from "./SampleRepos.jsx";

const STEPS = [
  {
    number: "01",
    title: "Choose your repository",
    description:
      "Paste a public GitHub URL or bring a ZIP archive from your computer."
  },
  {
    number: "02",
    title: "Trace its architecture",
    description:
      "Extract source structure, dependencies, functions, and code-health signals in your browser."
  },
  {
    number: "03",
    title: "Find your way through",
    description:
      "Explore the dependency atlas, investigate cycles, and discover safer places to start."
  }
];

/**
 * Composes the entry experience for Astral Atlas.
 *
 * Repository analysis is delegated through onAnalyze. This keeps the
 * landing page independent of the engine that will be connected later.
 */
export default function LandingPage({
  onAnalyze,
  notice,
  onDismissNotice
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [urlError, setUrlError] = useState("");

  function handleUrlSubmit(rawUrl, source = "form") {
    const result = parseGithubRepoUrl(rawUrl);

    if (result.error) {
      setUrlError(result.error);
      return;
    }

    setUrlError("");

    onAnalyze({
      kind: "github",
      source,
      owner: result.owner,
      repo: result.repo,
      repoUrl: result.repoUrl
    });
  }

  function handleSampleSelect(sample) {
    setRepoUrl(sample.url);
    setUrlError("");
    handleUrlSubmit(sample.url, "sample");
  }

  function handleZipSelect(file) {
    onAnalyze({
      kind: "zip",
      source: "upload",
      file
    });
  }

  return (
    <div className="landing-page">
      <Starfield />

      <div className="landing-content">
        <header className="site-header">
          <a
            className="brand"
            href="#top"
            aria-label="Astral Atlas home"
          >
            <span className="brand-mark">
              <Icon name="atlas" size={25} />
            </span>

            <span className="brand-name">
              Astral <span>Atlas</span>
            </span>
          </a>

          <nav className="site-nav" aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#privacy">Privacy</a>

            <span className="nav-privacy">
              <Icon name="shield" size={14} />
              Browser-first
            </span>
          </nav>
        </header>

        <main id="top">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-kicker">
              <span className="hero-kicker-dot" aria-hidden="true" />
              <span>WEBSTER 2026 / PROBLEM 06</span>
            </div>

            <h1 id="hero-title" className="hero-title">
              Navigate the architecture
              <br />
              <em>hidden in your code.</em>
            </h1>

            <p className="hero-description">
              Turn an unfamiliar JavaScript or TypeScript repository
              into an interactive map of its modules, dependencies,
              and hidden circular paths.
            </p>

            <div className="ingestion-card">
              <div className="ingestion-heading">
                <h2>Plot your first repository</h2>
                <span>JavaScript / TypeScript</span>
              </div>

              <UrlForm
                value={repoUrl}
                onChange={(nextValue) => {
                  setRepoUrl(nextValue);
                  setUrlError("");
                }}
                onSubmit={(value) => handleUrlSubmit(value)}
                error={urlError}
              />

              <p
                id="repository-url-help"
                className="url-help"
              >
                Public GitHub URLs work with or without the
                <code> .git </code>
                suffix, including repository links to a branch.
              </p>

              <div className="ingestion-divider">
                <span>or chart from a local archive</span>
              </div>

              <ZipDropzone onSelect={handleZipSelect} />

              {notice && (
                <div className="repo-status" role="status">
                  <Icon name="info" size={18} />

                  <p>{notice}</p>

                  <button
                    className="repo-status-close"
                    type="button"
                    onClick={onDismissNotice}
                    aria-label="Dismiss status message"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              )}
            </div>

            <div className="hero-trustline" aria-label="Product principles">
              <span>
                <Icon name="shield" size={15} />
                Your source stays in your browser
              </span>

              <span>
                <Icon name="layers" size={15} />
                Modules, functions, and dependencies
              </span>

              <span>
                <Icon name="compass" size={15} />
                Built for code exploration
              </span>
            </div>

            <SampleRepos onSelect={handleSampleSelect} />
          </section>

          <section
            id="how-it-works"
            className="how-section"
            aria-labelledby="how-title"
          >
            <div className="section-heading">
              <span className="eyebrow">From codebase to constellation</span>

              <h2 id="how-title">
                Every repository has a shape.
              </h2>

              <p>
                Astral Atlas reveals that structure in three stages,
                so you can understand an unfamiliar project before
                changing it.
              </p>
            </div>

            <div className="steps-grid">
              {STEPS.map((step) => (
                <article className="step-card" key={step.number}>
                  <span className="step-number">
                    STAGE {step.number}
                  </span>

                  <h3>{step.title}</h3>

                  <p>{step.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section
            id="privacy"
            className="privacy-section"
            aria-labelledby="privacy-title"
          >
            <div className="privacy-icon">
              <Icon name="shield" size={22} />
            </div>

            <div>
              <h2 id="privacy-title">
                Your code stays on your side of the telescope.
              </h2>

              <p>
                Source files are intended to be fetched into and
                analysed inside your browser. Atlas Edge handles
                repository metadata only, never source contents.
                ZIP archives are processed locally. Cached summaries
                remain in your browser's IndexedDB.
              </p>
            </div>
          </section>
        </main>

        <footer className="site-footer">
          <p className="footer-brand">
            <Icon name="atlas" size={15} />
            {" "}The Astral Cartographer
          </p>

          <p>Webster 2026 · Problem Statement 06</p>

          <p>Map the code. Find your way.</p>
        </footer>
      </div>
    </div>
  );
}
