/**
 * Optional Atlas Edge metadata relay client.
 *
 * WHY: The browser normally calls GitHub directly. Atlas Edge is used
 * only when an upstream metadata request is rate-limited.
 *
 * Expected Worker route:
 * GET /api/tree?owner=<owner>&repo=<repo>&ref=<branch>
 */

export class AtlasEdgeError extends Error {
  constructor(message, {
    status = 0,
    cause = null
  } = {}) {
    super(message);
    this.name = "AtlasEdgeError";
    this.status = status;
    this.cause = cause;
  }
}

export default class AtlasEdgeClient {
  /**
   * @param {{baseUrl?:string}} [options]
   */
  constructor({ baseUrl = "" } = {}) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  /**
   * Whether an Edge URL has been configured.
   *
   * @returns {boolean}
   */
  get configured() {
    return this.baseUrl.length > 0;
  }

  /**
   * Fetch the repository's recursive tree through Atlas Edge.
   *
   * The Worker will cache this metadata response. It never receives
   * source-file contents through this method.
   *
   * @param {string} owner
   * @param {string} repo
   * @param {string} ref
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<{sha:string,tree:Array<object>,truncated:boolean}>}
   */
  async getTree(
    owner,
    repo,
    ref,
    { signal } = {}
  ) {
    if (!this.configured) {
      throw new AtlasEdgeError(
        "Atlas Edge isn't configured for this deployment."
      );
    }

    const url = new URL(
      `${this.baseUrl}/api/tree`
    );

    url.searchParams.set("owner", owner);
    url.searchParams.set("repo", repo);
    url.searchParams.set("ref", ref);

    let response;

    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal,
        cache: "no-store"
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }

      throw new AtlasEdgeError(
        "Atlas Edge could not be reached. Check its deployment and CORS settings.",
        { cause: error }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");

      throw new AtlasEdgeError(
        text.slice(0, 300) ||
          `Atlas Edge returned HTTP ${response.status}.`,
        { status: response.status }
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw new AtlasEdgeError(
        "Atlas Edge returned an unreadable JSON response."
      );
    }

    if (!Array.isArray(data.tree)) {
      throw new AtlasEdgeError(
        "Atlas Edge returned a response without a valid tree."
      );
    }

    return {
      sha: data.sha ?? "",
      tree: data.tree,
      truncated: data.truncated === true
    };
  }
}