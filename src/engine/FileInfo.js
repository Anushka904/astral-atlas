/**
 * Compact analysis summary for one JavaScript/TypeScript source file.
 *
 * WHY: The full Babel AST can be large. The rest of Astral Atlas should
 * operate on these small summaries instead of retaining ASTs.
 */
export default class FileInfo {
  /**
   * @param {{
   *   path?:string,
   *   sha?:string|null,
   *   loc?:number,
   *   tokenCount?:number,
   *   cyclomaticComplexity?:number,
   *   imports?:object[],
   *   exports?:string[],
   *   functions?:object[],
   *   parseStatus?:string,
   *   parseErrors?:object[],
   *   warning?:string|null
   * }} [data]
   */
  constructor(data = {}) {
    this.path = data.path ?? "";
    this.sha = data.sha ?? null;
    this.loc = data.loc ?? 0;
    this.tokenCount = data.tokenCount ?? 0;

    this.cyclomaticComplexity =
      data.cyclomaticComplexity ?? 1;

    this.imports = [...(data.imports ?? [])];
    this.exports = [...new Set(data.exports ?? [])];
    this.functions = [...(data.functions ?? [])];

    this.parseStatus = data.parseStatus ?? "ok";
    this.parseErrors = [...(data.parseErrors ?? [])];
    this.warning = data.warning ?? null;
  }

  /**
   * Create a summary for a file that could not be parsed.
   * The rest of the repository can continue to be processed.
   *
   * @param {string} path
   * @param {string|null} sha
   * @param {string} message
   * @returns {FileInfo}
   */
  static failed(path, sha, message) {
    return new FileInfo({
      path,
      sha,
      loc: 0,
      tokenCount: 0,
      cyclomaticComplexity: 0,
      imports: [],
      exports: [],
      functions: [],
      parseStatus: "error",
      parseErrors: [{ message }],
      warning: message
    });
  }

  /**
   * Return a structured-clone-safe plain object.
   * No Babel AST nodes or source text are included.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      path: this.path,
      sha: this.sha,
      loc: this.loc,
      tokenCount: this.tokenCount,
      cyclomaticComplexity: this.cyclomaticComplexity,
      imports: this.imports.map((entry) => ({
        ...entry,
        importedNames: [...(entry.importedNames ?? [])],
        localNames: [...(entry.localNames ?? [])]
      })),
      exports: [...this.exports],
      functions: this.functions.map((item) =>
        typeof item.toJSON === "function"
          ? item.toJSON()
          : { ...item, calls: [...(item.calls ?? [])] }
      ),
      parseStatus: this.parseStatus,
      parseErrors: this.parseErrors.map((error) => ({
        message: error.message,
        code: error.code ?? null,
        line: error.line ?? null,
        column: error.column ?? null
      })),
      warning: this.warning
    };
  }
}