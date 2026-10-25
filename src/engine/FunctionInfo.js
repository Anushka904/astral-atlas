/**
 * Compact function metadata extracted from a Babel AST.
 *
 * WHY:
 * - Function names alone are not unique in a repository.
 * - Binding IDs let the resolver distinguish shadowed variables and aliases.
 * - Class/object metadata enables conservative method resolution.
 * - Call references contain plain data, never Babel NodePath or AST objects.
 */

export default class FunctionInfo {
  /**
   * @param {{
   *   id?:string,
   *   name?:string,
   *   startLine?:number,
   *   endLine?:number,
   *   startColumn?:number,
   *   endColumn?:number,
   *   bindingId?:string|null,
   *   exportNames?:string[],
   *   classExportNames?:string[],
   *   className?:string|null,
   *   classBindingId?:string|null,
   *   ownerBindingId?:string|null,
   *   cyclomaticComplexity?:number,
   *   calls?:Array<object|string>,
   *   async?:boolean,
   *   generator?:boolean,
   *   kind?:string
   * }} [data]
   */
  constructor(data = {}) {
    this.name = data.name ?? "anonymous";
    this.startLine = data.startLine ?? 1;
    this.endLine = data.endLine ?? this.startLine;
    this.startColumn = data.startColumn ?? 0;
    this.endColumn = data.endColumn ?? 0;

    this.id =
      data.id ??
      `${this.name}@${this.startLine}:${this.startColumn}`;

    this.bindingId = data.bindingId ?? null;

    this.exportNames = [
      ...new Set(data.exportNames ?? [])
    ];

    this.classExportNames = [
      ...new Set(data.classExportNames ?? [])
    ];

    this.className = data.className ?? null;
    this.classBindingId = data.classBindingId ?? null;
    this.ownerBindingId = data.ownerBindingId ?? null;

    this.cyclomaticComplexity =
      data.cyclomaticComplexity ?? 1;

    this.calls = (data.calls ?? []).map((call) =>
      typeof call === "string"
        ? call
        : {
            ...call,
            bindingChain: [...(call.bindingChain ?? [])],
            receiverBindingChain: [
              ...(call.receiverBindingChain ?? [])
            ],
            receiverClassBindingChain: [
              ...(call.receiverClassBindingChain ?? [])
            ]
          }
    );

    this.async = data.async === true;
    this.generator = data.generator === true;
    this.kind = data.kind ?? "function";
  }

  /**
   * Return a plain, structured-clone-safe representation.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      startLine: this.startLine,
      endLine: this.endLine,
      startColumn: this.startColumn,
      endColumn: this.endColumn,
      bindingId: this.bindingId,
      exportNames: [...this.exportNames],
      classExportNames: [...this.classExportNames],
      className: this.className,
      classBindingId: this.classBindingId,
      ownerBindingId: this.ownerBindingId,
      cyclomaticComplexity: this.cyclomaticComplexity,
      calls: this.calls.map((call) =>
        typeof call === "string"
          ? call
          : {
              ...call,
              bindingChain: [...(call.bindingChain ?? [])],
              receiverBindingChain: [
                ...(call.receiverBindingChain ?? [])
              ],
              receiverClassBindingChain: [
                ...(call.receiverClassBindingChain ?? [])
              ]
            }
      ),
      async: this.async,
      generator: this.generator,
      kind: this.kind
    };
  }
}