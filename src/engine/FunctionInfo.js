/**
 * Compact information about a function discovered in a source file.
 *
 * WHY: The UI and graph engine need function metadata, not full AST nodes.
 * Keeping this record serializable makes it safe to transfer from a Worker.
 */
export default class FunctionInfo {
  /**
   * @param {{
   *   id?:string,
   *   name?:string,
   *   startLine?:number,
   *   endLine?:number,
   *   cyclomaticComplexity?:number,
   *   calls?:string[],
   *   async?:boolean,
   *   generator?:boolean,
   *   kind?:string
   * }} [data]
   */
  constructor(data = {}) {
    this.name = data.name ?? "anonymous";
    this.startLine = data.startLine ?? 1;
    this.endLine = data.endLine ?? this.startLine;
    this.id =
      data.id ??
      `${this.name}@${this.startLine}`;

    this.cyclomaticComplexity =
      data.cyclomaticComplexity ?? 1;

    this.calls = [...new Set(data.calls ?? [])];
    this.async = data.async === true;
    this.generator = data.generator === true;
    this.kind = data.kind ?? "function";
  }

  /**
   * Return a plain JSON-compatible representation.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      startLine: this.startLine,
      endLine: this.endLine,
      cyclomaticComplexity: this.cyclomaticComplexity,
      calls: [...this.calls],
      async: this.async,
      generator: this.generator,
      kind: this.kind
    };
  }
}