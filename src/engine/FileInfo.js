/**
 * Compact analysis summary for one JavaScript/TypeScript file.
 *
 * WHY:
 * - The full Babel AST must remain inside the parsing worker.
 * - Graph construction needs import, export, function and binding metadata.
 * - Export bindings preserve cases such as `export { internal as public }`.
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
   *   exportBindings?:object[],
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
    this.exportBindings = [...(data.exportBindings ?? [])];
    this.functions = [...(data.functions ?? [])];

    this.parseStatus = data.parseStatus ?? "ok";
    this.parseErrors = [...(data.parseErrors ?? [])];
    this.warning = data.warning ?? null;
  }

  /**
   * Create an error summary for a single failed source file.
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
      exportBindings: [],
      functions: [],
      parseStatus: "error",
      parseErrors: [{ message }],
      warning: message
    });
  }

  /**
   * Return a compact plain object safe for structured cloning.
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
      exportBindings: this.exportBindings.map(
        (binding) => ({ ...binding })
      ),
      functions: this.functions.map((fn) =>
        typeof fn.toJSON === "function"
          ? fn.toJSON()
          : {
              ...fn,
              exportNames: [...(fn.exportNames ?? [])],
              classExportNames: [
                ...(fn.classExportNames ?? [])
              ],
              calls: (fn.calls ?? []).map((call) =>
                typeof call === "string"
                  ? call
                  : {
                      ...call,
                      bindingChain: [
                        ...(call.bindingChain ?? [])
                      ],
                      receiverBindingChain: [
                        ...(call.receiverBindingChain ?? [])
                      ],
                      receiverClassBindingChain: [
                        ...(call.receiverClassBindingChain ?? [])
                      ]
                    }
              )
            }
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