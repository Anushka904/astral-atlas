/**
 * GitHub repository URL parsing and validation.
 *
 * WHY: URL parsing is isolated from React and network requests so the same
 * validation rules can be tested and reused throughout the application.
 */

export class RepoUrlError extends Error {
  constructor(message, code = "INVALID_REPO_URL") {
    super(message);
    this.name = "RepoUrlError";
    this.code = code;
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Decode an individual URL path component safely.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RepoUrlError(
      "The repository URL contains invalid URL encoding."
    );
  }
}

/**
 * Parse a public GitHub repository URL.
 *
 * Supported forms:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/tree/branch/path
 *
 * For a branch name containing slashes, URL-encode the branch name
 * so it can be distinguished from the optional subdirectory path.
 *
 * @param {string} input
 * @returns {{
 *   owner: string,
 *   repo: string,
 *   fullName: string,
 *   branch: string|null,
 *   subpath: string,
 *   url: string
 * }}
 */
export function parseGitHubRepoUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new RepoUrlError(
      "Enter a GitHub repository URL to get started."
    );
  }

  const raw = input.trim();

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    throw new RepoUrlError(
      "That doesn't look like a valid URL. Paste a full GitHub repository link."
    );
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new RepoUrlError(
      "Use an HTTP or HTTPS GitHub repository URL."
    );
  }

  if (
    parsed.hostname.toLowerCase() !== "github.com" &&
    parsed.hostname.toLowerCase() !== "www.github.com"
  ) {
    throw new RepoUrlError(
      "Please use a repository hosted on github.com."
    );
  }

  if (parsed.username || parsed.password) {
    throw new RepoUrlError(
      "Remove credentials from the URL. Astral Atlas accepts repository links only."
    );
  }

  if (parsed.port) {
    throw new RepoUrlError(
      "A custom port isn't supported in a GitHub repository URL."
    );
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeSegment);

  if (segments.length < 2) {
    throw new RepoUrlError(
      "The URL must contain both the repository owner and repository name."
    );
  }

  const owner = segments[0];
  let repo = segments[1];

  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }

  if (
    !OWNER_PATTERN.test(owner) ||
    owner === "." ||
    owner === ".."
  ) {
    throw new RepoUrlError(
      "The repository owner in this URL is invalid."
    );
  }

  if (
    !REPO_PATTERN.test(repo) ||
    repo === "." ||
    repo === ".." ||
    repo.includes("..") && repo === ".."
  ) {
    throw new RepoUrlError(
      "The repository name in this URL is invalid."
    );
  }

  const route = segments[2] ?? "";
  let branch = null;
  let subpath = "";

  if (route === "tree") {
    if (!segments[3]) {
      throw new RepoUrlError(
        "This tree URL is missing its branch name."
      );
    }

    branch = segments[3];
    subpath = segments.slice(4).join("/");

    if (branch.startsWith("-") || branch.trim() === "") {
      throw new RepoUrlError(
        "The branch name in this URL is invalid."
      );
    }
  } else if (route !== "") {
    throw new RepoUrlError(
      "Paste the repository homepage or a /tree/branch URL, not an individual file or settings page."
    );
  }

  const canonicalRepo = repo.replace(/\.git$/i, "");

  return {
    owner,
    repo: canonicalRepo,
    fullName: `${owner}/${canonicalRepo}`,
    branch,
    subpath,
    url: `https://github.com/${owner}/${canonicalRepo}`
  };
}