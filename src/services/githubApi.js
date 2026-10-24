/**
 * Read-only GitHub API client.
 *
 * This module never saves personal access tokens.
 * A token is supplied per request and used only in request headers.
 */

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";

export class GitHubHttpError extends Error {
  constructor(message, {
    status = 0,
    rateLimited = false,
    retryAfter = null,
    responseData = null
  } = {}) {
    super(message);
    this.name = "GitHubHttpError";
    this.status = status;
    this.rateLimited = rateLimited;
    this.retryAfter = retryAfter;
    this.responseData = responseData;
  }
}

/**
 * Extract a readable message from an HTTP response body.
 *
 * @param {Response} response
 * @returns {Promise<{message:string,data:object|null}>}
 */
async function readErrorBody(response) {
  const text = await response.text().catch(() => "");

  if (!text) {
    return {
      message: response.statusText || "Request failed.",
      data: null
    };
  }

  try {
    const data = JSON.parse(text);

    return {
      message: data.message || response.statusText,
      data
    };
  } catch {
    return {
      message: text.slice(0, 300),
      data: null
    };
  }
}

/**
 * Determine whether a failed GitHub request is rate-limited.
 *
 * @param {number} status
 * @param {Headers} headers
 * @param {string} message
 * @returns {boolean}
 */
export function isGitHubRateLimit(
  status,
  headers,
  message = ""
) {
  if (status === 429) {
    return true;
  }

  if (status !== 403) {
    return false;
  }

  const remaining = headers?.get("x-ratelimit-remaining");
  const normalizedMessage = message.toLowerCase();

  return (
    remaining === "0" ||
    headers?.has("retry-after") === true ||
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("secondary rate limit")
  );
}

/**
 * Perform a read-only JSON request against GitHub.
 *
 * @param {string} url
 * @param {{token?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function fetchGitHubJson(
  url,
  { token, signal } = {}
) {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  });

  if (token?.trim()) {
    headers.set(
      "Authorization",
      `Bearer ${token.trim()}`
    );
  }

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal,
      cache: "no-store"
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }

    const networkError = new Error(
      "Could not reach GitHub. Check your internet connection and try again."
    );

    networkError.name = "NetworkError";
    networkError.cause = error;

    throw networkError;
  }

  if (!response.ok) {
    const body = await readErrorBody(response);

    const retryAfterHeader = response.headers.get("retry-after");

    const retryAfter = retryAfterHeader
      ? Number(retryAfterHeader)
      : null;

    throw new GitHubHttpError(
      body.message || `GitHub returned HTTP ${response.status}.`,
      {
        status: response.status,
        rateLimited: isGitHubRateLimit(
          response.status,
          response.headers,
          body.message
        ),
        retryAfter:
          Number.isFinite(retryAfter) ? retryAfter : null,
        responseData: body.data
      }
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(
      "GitHub returned a response that could not be read as JSON."
    );
  }
}

/**
 * Read public repository metadata.
 *
 * The default branch is needed when the input URL doesn't specify one.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {{token?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function getRepositoryMetadata(
  owner,
  repo,
  options = {}
) {
  const data = await fetchGitHubJson(
    `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    options
  );

  if (data.private === true) {
    throw new Error(
      "Astral Atlas currently supports public repositories only."
    );
  }

  if (!data.default_branch) {
    throw new Error(
      "GitHub did not provide a default branch for this repository."
    );
  }

  return data;
}

/**
 * Retrieve a recursive Git tree for a branch or tree reference.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @param {{token?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<{sha:string,tree:Array<object>,truncated:boolean}>}
 */
export async function getRecursiveTree(
  owner,
  repo,
  ref,
  options = {}
) {
  if (!ref || typeof ref !== "string") {
    throw new TypeError(
      "A branch name or tree reference is required."
    );
  }

  const encodedRef = encodeURIComponent(ref);

  const data = await fetchGitHubJson(
    `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodedRef}?recursive=1`,
    options
  );

  if (!Array.isArray(data.tree)) {
    throw new Error(
      "GitHub's tree response did not contain a valid file list."
    );
  }

  return {
    sha: data.sha ?? "",
    tree: data.tree,
    truncated: data.truncated === true
  };
}

/**
 * Retrieve source text from GitHub's raw content host.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @param {string} filePath
 * @param {{signal?:AbortSignal,token?:string}} [options]
 * @returns {Promise<string>}
 */
export async function fetchRawFile(
  owner,
  repo,
  ref,
  filePath,
  { signal, token } = {}
) {
  // Encode path segments separately so ordinary folder separators remain.
  const encodedRef = ref
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    `${RAW_BASE}/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/${encodedRef}/${encodedPath}`;

  const headers = new Headers();

  // Raw-file requests are normally anonymous. A supplied token is only
  // included when a caller deliberately chooses the authenticated route.
  if (token?.trim()) {
    headers.set(
      "Authorization",
      `Bearer ${token.trim()}`
    );
  }

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal,
      cache: "no-store"
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }

    const networkError = new Error(
      `Network error while downloading ${filePath}.`
    );

    networkError.name = "NetworkError";
    networkError.cause = error;

    throw networkError;
  }

  if (!response.ok) {
    const message = await response.text().catch(() => "");

    throw new GitHubHttpError(
      message.slice(0, 300) ||
        `Unable to download ${filePath}.`,
      {
        status: response.status,
        rateLimited: isGitHubRateLimit(
          response.status,
          response.headers,
          message
        )
      }
    );
  }

  return response.text();
}