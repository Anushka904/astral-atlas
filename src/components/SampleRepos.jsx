
import Icon from "./Icon.jsx";

const SAMPLE_REPOSITORIES = [
  {
    owner: "sindresorhus",
    repo: "p-limit",
    url: "https://github.com/sindresorhus/p-limit",
    description: "A compact utility for limiting concurrent promise execution.",
    category: "Small"
  },
  {
    owner: "expressjs",
    repo: "express",
    url: "https://github.com/expressjs/express",
    description: "A widely used web framework with meaningful module relationships.",
    category: "Medium"
  },
  {
    owner: "axios",
    repo: "axios",
    url: "https://github.com/axios/axios",
    description: "An HTTP client with adapters, utilities, and a modular source tree.",
    category: "Medium"
  }
];

/**
 * Sample repositories are examples, not guaranteed benchmarking results.
 * Repository sizes and public accessibility may change.
 */
export default function SampleRepos({ onSelect }) {
  return (
    <section
      className="samples-section"
      aria-labelledby="samples-title"
    >
      <div className="samples-topline">
        <p id="samples-title">Start with a known repository</p>
        <p>Public GitHub projects</p>
      </div>

      <div className="samples-grid">
        {SAMPLE_REPOSITORIES.map((sample) => (
          <button
            className="sample-card"
            type="button"
            key={sample.url}
            onClick={() => onSelect(sample)}
            aria-label={`Analyse sample repository ${sample.owner}/${sample.repo}`}
          >
            <span className="sample-card-top">
              <span className="sample-card-name">
                {sample.owner}/{sample.repo}
              </span>

              <span
                className="sample-card-symbol"
                aria-hidden="true"
              >
                <Icon name="arrowUpRight" size={17} />
              </span>
            </span>

            <span className="sample-card-description">
              {sample.description}
            </span>

            <span className="sample-card-action">
              <Icon name="compass" size={14} />
              Explore sample
              <span aria-hidden="true">·</span>
              {sample.category}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
