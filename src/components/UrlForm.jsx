
import Icon from "./Icon.jsx";

/**
 * Parses a public-repository URL into its owner and repository name.
 * Branches and paths after /tree/ are not part of the repository identity.
 *
 * This is input validation, not proof that a repository is public or exists.
 */
export function parseGithubRepoUrl(input) {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      error: "Enter a GitHub repository URL to begin."
    };
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url;

  try {
    url = new URL(candidate);
  } catch {
    return {
      error: "That URL doesn't look valid. Check the address and try again."
    };
  }

  const hostname = url.hostname.toLowerCase();

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    return {
      error: "Use a standard GitHub HTTPS repository URL."
    };
  }

  if (
    hostname !== "github.com" &&
    hostname !== "www.github.com"
  ) {
    return {
      error: "Use a repository hosted on github.com."
    };
  }

  if (url.username || url.password) {
    return {
      error: "Remove any embedded credentials from the URL."
    };
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean);

  if (segments.length < 2) {
    return {
      error: "Include both the GitHub owner and repository name."
    };
  }

  let owner;
  let repository;

  try {
    owner = decodeURIComponent(segments[0]);
    repository = decodeURIComponent(segments[1]);
  } catch {
    return {
      error: "The repository address contains invalid URL encoding."
    };
  }

  repository = repository.replace(/\.git$/i, "");

  const validOwner =
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(
      owner
    );

  const validRepository =
    /^[A-Za-z0-9_.-]+$/.test(repository) &&
    repository !== "." &&
    repository !== "..";

  if (!validOwner || !validRepository) {
    return {
      error: "The owner or repository name contains unsupported characters."
    };
  }

  return {
    owner,
    repo: repository,
    repoUrl: `https://github.com/${owner}/${repository}`
  };
}

export default function UrlForm({
  value,
  onChange,
  onSubmit,
  error
}) {
  function handleSubmit(event) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <form
      className="url-form"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="url-input-wrap">
        <Icon name="github" size={19} />

        <label
          className="visually-hidden"
          htmlFor="repository-url"
        >
          Public GitHub repository URL
        </label>

        <input
          id="repository-url"
          className="url-input"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck="false"
          placeholder="https://github.com/owner/repository"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={
            error ? "repository-url-error" : "repository-url-help"
          }
        />
      </div>

      <button
        className="button button--primary"
        type="submit"
      >
        <span>Chart repository</span>
        <Icon name="arrowRight" size={17} />
      </button>

      {error && (
        <p
          id="repository-url-error"
          className="url-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );
}
