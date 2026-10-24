
export default function App() {
  return (
    <main className="boot-shell">
      <section
        className="boot-card"
        aria-labelledby="app-title"
      >
        <p className="boot-eyebrow">
          WEBSTER 2026 / PROBLEM 06
        </p>

        <div className="boot-emblem" aria-hidden="true">
          ✦
        </div>

        <h1 id="app-title">
          Astral <span>Atlas</span>
        </h1>

        <p className="boot-description">
          A new way to navigate unfamiliar code.
        </p>

        <div className="boot-status" role="status">
          <span
            className="boot-status-dot"
            aria-hidden="true"
          />
          Project foundation initialized
        </div>

        <p className="boot-note">
          The observatory begins here. Repository ingestion,
          AST analysis, and the interactive atlas will be
          connected in the following milestones.
        </p>
      </section>

      <footer className="boot-footer">
        BUILT FOR THE ASTRAL CARTOGRAPHER CHALLENGE
      </footer>
    </main>
  );
}
