/**
 * Conservative static call resolver for Astral Atlas.
 *
 * Resolution evidence:
 * - Lexical Babel binding IDs
 * - Simple variable alias chains
 * - Import/export bindings and re-export edges
 * - Class identity and known receiver bindings
 * - Object-literal method ownership
 *
 * Uncertain calls remain ambiguous or unresolved.
 * No AST nodes or source text are retained here.
 */

function functionKey(filePath, bindingId) {
  return `${filePath}\u0000${bindingId}`;
}

function unique(items) {
  return [...new Set(items)];
}

/**
 * DependencyGraph uses kind="function" for function nodes and stores the
 * original AST node kind in functionKind. Class identity provides an
 * additional guard for older summaries.
 *
 * @param {object} fn
 * @returns {boolean}
 */
function isClassMethod(fn) {
  if (
    fn.functionKind === "ClassMethod" ||
    fn.functionKind === "ClassPrivateMethod"
  ) {
    return true;
  }

  return Boolean(
    fn.className &&
    fn.classBindingId &&
    fn.name.startsWith(`${fn.className}.`)
  );
}

/**
 * Get the method name without a class prefix.
 *
 * @param {object} fn
 * @returns {string}
 */
function getMethodPropertyName(fn) {
  if (isClassMethod(fn) && fn.className) {
    const prefix = `${fn.className}.`;

    if (fn.name.startsWith(prefix)) {
      return fn.name.slice(prefix.length);
    }
  }

  return fn.name;
}

export default class CallResolver {
  constructor() {
    this.lastStats = {
      total: 0,
      resolved: 0,
      ambiguous: 0,
      unresolved: 0
    };
  }

  /**
   * Resolve the call references already recorded in a DependencyGraph.
   *
   * @param {object} graph
   * @returns {{stats:object,references:Array<object>}}
   */
  resolve(graph) {
    if (
      !graph ||
      !(graph.nodes instanceof Map) ||
      !(graph.functionNodes instanceof Map) ||
      !Array.isArray(graph.callReferences)
    ) {
      throw new TypeError(
        "CallResolver expects a DependencyGraph built by GraphBuilder."
      );
    }

    const functionsByBinding = new Map();
    const functionsByFile = new Map();

    for (const fn of graph.functionNodes.values()) {
      if (!functionsByFile.has(fn.filePath)) {
        functionsByFile.set(fn.filePath, []);
      }

      functionsByFile.get(fn.filePath).push(fn);

      if (fn.bindingId) {
        const key = functionKey(fn.filePath, fn.bindingId);

        if (!functionsByBinding.has(key)) {
          functionsByBinding.set(key, []);
        }

        functionsByBinding.get(key).push(fn);
      }
    }

    const context = {
      graph,
      functionsByBinding,
      functionsByFile
    };

    const stats = {
      total: graph.callReferences.length,
      resolved: 0,
      ambiguous: 0,
      unresolved: 0
    };

    for (const reference of graph.callReferences) {
      const caller = graph.functionNodes.get(
        reference.sourceFunctionId
      );

      if (!caller) {
        graph.resolveCallReference(reference.id, {
          targetFunctionIds: [],
          status: "unresolved",
          resolutionReason: "calling-function-not-found"
        });

        stats.unresolved += 1;
        continue;
      }

      const targets = this.findTargets(
        context,
        caller,
        reference
      );

      const targetFunctionIds = unique(
        targets.map((fn) => fn.id)
      );

      let status;
      let reason;

      if (targetFunctionIds.length === 1) {
        status = "resolved";
        reason = "one-static-target";
      } else if (targetFunctionIds.length > 1) {
        status = "ambiguous";
        reason = "multiple-static-targets";
      } else {
        status = "unresolved";
        reason =
          reference.resolutionReason ??
          this.makeUnresolvedReason(caller, reference);
      }

      graph.resolveCallReference(reference.id, {
        targetFunctionIds,
        status,
        resolutionReason: reason
      });

      stats[status] += 1;
    }

    this.lastStats = stats;

    return {
      stats: { ...stats },
      references: graph.callReferences.map((reference) => ({
        ...reference,
        targetFunctionIds: [...reference.targetFunctionIds]
      }))
    };
  }

  /**
   * Select targets using the strongest available static evidence.
   *
   * @param {object} context
   * @param {object} caller
   * @param {object} call
   * @returns {object[]}
   */
  findTargets(context, caller, call) {
    const filePath = caller.filePath;

    if (
      call.callKind === "identifier" ||
      call.callKind === "constructor"
    ) {
      const localTargets = [];

      for (const bindingId of call.bindingChain ?? []) {
        const matches =
          context.functionsByBinding.get(
            functionKey(filePath, bindingId)
          ) ?? [];

        localTargets.push(...matches);
      }

      if (localTargets.length > 0) {
        if (call.callKind === "constructor") {
          return this.findClassMethodsByBinding(
            context,
            filePath,
            localTargets
              .map((target) => target.bindingId)
              .filter(Boolean),
            "constructor"
          );
        }

        return unique(localTargets);
      }

      if (call.importSource && call.importedName) {
        const targetPath = this.findImportTarget(
          context.graph,
          filePath,
          call.importSource
        );

        if (!targetPath) {
          return [];
        }

        if (call.callKind === "constructor") {
          return this.resolveExportedClassMethods(
            context,
            targetPath,
            call.importedName,
            "constructor"
          );
        }

        return this.resolveExportedFunctions(
          context,
          targetPath,
          call.importedName
        );
      }

      // A local class binding has class methods, not a function node with
      // the same binding ID. Resolve only an explicit constructor body.
      if (call.callKind === "constructor") {
        return this.findClassMethodsByBinding(
          context,
          filePath,
          call.bindingChain ?? [],
          "constructor"
        );
      }

      return [];
    }

    if (
      call.callKind === "member" ||
      call.callKind === "optional-member" ||
      call.callKind === "this-member" ||
      call.callKind === "dynamic-member"
    ) {
      if (!call.propertyName) {
        return [];
      }

      if (
        call.callKind === "this-member" ||
        call.receiverKind === "this"
      ) {
        return this.findClassMethodsByBinding(
          context,
          filePath,
          [call.callerClassBindingId].filter(Boolean),
          call.propertyName
        );
      }

      if (
        call.receiverImportSource &&
        call.receiverImportedName === "*"
      ) {
        const targetPath = this.findImportTarget(
          context.graph,
          filePath,
          call.receiverImportSource
        );

        return targetPath
          ? this.resolveExportedFunctions(
              context,
              targetPath,
              call.propertyName
            )
          : [];
      }

      if (
        call.receiverImportSource &&
        call.receiverImportedName &&
        call.receiverImportedName !== "*"
      ) {
        const targetPath = this.findImportTarget(
          context.graph,
          filePath,
          call.receiverImportSource
        );

        return targetPath
          ? this.resolveExportedClassMethods(
              context,
              targetPath,
              call.receiverImportedName,
              call.propertyName
            )
          : [];
      }

      if (call.receiverClassBindingChain?.length) {
        const localMethods = this.findClassMethodsByBinding(
          context,
          filePath,
          call.receiverClassBindingChain,
          call.propertyName
        );

        if (localMethods.length > 0) {
          return localMethods;
        }
      }

      if (
        call.receiverClassImportSource &&
        call.receiverClassImportedName
      ) {
        const targetPath = this.findImportTarget(
          context.graph,
          filePath,
          call.receiverClassImportSource
        );

        if (targetPath) {
          const methods = this.resolveExportedClassMethods(
            context,
            targetPath,
            call.receiverClassImportedName,
            call.propertyName
          );

          if (methods.length > 0) {
            return methods;
          }
        }
      }

      if (call.receiverBindingChain?.length) {
        const classMethods = this.findClassMethodsByBinding(
          context,
          filePath,
          call.receiverBindingChain,
          call.propertyName
        );

        if (classMethods.length > 0) {
          return classMethods;
        }

        return this.findObjectMethodsByBinding(
          context,
          filePath,
          call.receiverBindingChain,
          call.propertyName
        );
      }
    }

    return [];
  }

  /**
   * Find the module reached by a particular import specifier.
   *
   * @param {object} graph
   * @param {string} importerPath
   * @param {string} specifier
   * @returns {string|null}
   */
  findImportTarget(graph, importerPath, specifier) {
    const targets = new Set();

    for (const edge of graph.edges) {
      if (edge.source !== importerPath) {
        continue;
      }

      if (
        edge.imports.some(
          (entry) => entry.specifier === specifier
        )
      ) {
        targets.add(edge.target);
      }
    }

    return targets.size === 1 ? [...targets][0] : null;
  }

  /**
   * Resolve a public function export, following named and star re-exports.
   *
   * @param {object} context
   * @param {string} filePath
   * @param {string} exportName
   * @param {Set<string>} [visited]
   * @returns {object[]}
   */
  resolveExportedFunctions(
    context,
    filePath,
    exportName,
    visited = new Set()
  ) {
    const visitKey = `${filePath}\u0000${exportName}`;

    if (visited.has(visitKey)) {
      return [];
    }

    visited.add(visitKey);

    const fileFunctions =
      context.functionsByFile.get(filePath) ?? [];

    const direct = fileFunctions.filter(
      (fn) => (fn.exportNames ?? []).includes(exportName)
    );

    const fileNode = context.graph.nodes.get(filePath);

    for (const mapping of fileNode?.exportBindings ?? []) {
      if (
        mapping.exportedName !== exportName ||
        mapping.kind !== "local"
      ) {
        continue;
      }

      direct.push(
        ...fileFunctions.filter((fn) => {
          if (
            mapping.bindingId &&
            fn.bindingId === mapping.bindingId
          ) {
            return true;
          }

          return (
            !mapping.bindingId &&
            mapping.localName &&
            fn.name === mapping.localName
          );
        })
      );
    }

    if (direct.length > 0) {
      return unique(direct);
    }

    const reexported = [];

    for (const edge of context.graph.edges) {
      if (edge.source !== filePath) {
        continue;
      }

      for (const entry of edge.imports) {
        if (entry.importKind === "re-export") {
          const index = entry.localNames.indexOf(exportName);

          if (index < 0) {
            continue;
          }

          reexported.push(
            ...this.resolveExportedFunctions(
              context,
              edge.target,
              entry.importedNames[index] ?? exportName,
              new Set(visited)
            )
          );
        } else if (
          entry.importKind === "re-export-all" &&
          exportName !== "default"
        ) {
          reexported.push(
            ...this.resolveExportedFunctions(
              context,
              edge.target,
              exportName,
              new Set(visited)
            )
          );
        }
      }
    }

    return unique(reexported);
  }

  /**
   * Find methods belonging to class binding identities in a single file.
   *
   * @param {object} context
   * @param {string} filePath
   * @param {string[]} bindingIds
   * @param {string} methodName
   * @returns {object[]}
   */
  findClassMethodsByBinding(
    context,
    filePath,
    bindingIds,
    methodName
  ) {
    const identities = new Set(bindingIds);

    return (context.functionsByFile.get(filePath) ?? [])
      .filter(
        (fn) =>
          isClassMethod(fn) &&
          fn.classBindingId &&
          identities.has(fn.classBindingId) &&
          getMethodPropertyName(fn) === methodName
      );
  }

  /**
   * Resolve a method on a class exported by another module.
   *
   * @param {object} context
   * @param {string} filePath
   * @param {string} exportName
   * @param {string} methodName
   * @param {Set<string>} [visited]
   * @returns {object[]}
   */
  resolveExportedClassMethods(
    context,
    filePath,
    exportName,
    methodName,
    visited = new Set()
  ) {
    const visitKey =
      `${filePath}\u0000class\u0000${exportName}`;

    if (visited.has(visitKey)) {
      return [];
    }

    visited.add(visitKey);

    const fileNode = context.graph.nodes.get(filePath);
    const fileFunctions =
      context.functionsByFile.get(filePath) ?? [];

    const classBindingIds = new Set();

    for (const fn of fileFunctions) {
      if (
        (fn.classExportNames ?? []).includes(exportName) &&
        fn.classBindingId
      ) {
        classBindingIds.add(fn.classBindingId);
      }
    }

    for (const mapping of fileNode?.exportBindings ?? []) {
      if (
        mapping.exportedName === exportName &&
        mapping.kind === "local" &&
        mapping.bindingId
      ) {
        classBindingIds.add(mapping.bindingId);
      }
    }

    const direct = fileFunctions.filter(
      (fn) =>
        isClassMethod(fn) &&
        classBindingIds.has(fn.classBindingId) &&
        getMethodPropertyName(fn) === methodName
    );

    if (direct.length > 0) {
      return unique(direct);
    }

    const reexported = [];

    for (const edge of context.graph.edges) {
      if (edge.source !== filePath) {
        continue;
      }

      for (const entry of edge.imports) {
        if (entry.importKind === "re-export") {
          const index = entry.localNames.indexOf(exportName);

          if (index !== -1) {
            reexported.push(
              ...this.resolveExportedClassMethods(
                context,
                edge.target,
                entry.importedNames[index] ?? exportName,
                methodName,
                new Set(visited)
              )
            );
          }
        } else if (
          entry.importKind === "re-export-all" &&
          exportName !== "default"
        ) {
          reexported.push(
            ...this.resolveExportedClassMethods(
              context,
              edge.target,
              exportName,
              methodName,
              new Set(visited)
            )
          );
        }
      }
    }

    return unique(reexported);
  }

  /**
   * Resolve methods owned by an object-literal variable binding.
   *
   * @param {object} context
   * @param {string} filePath
   * @param {string[]} receiverBindingChain
   * @param {string} methodName
   * @returns {object[]}
   */
  findObjectMethodsByBinding(
    context,
    filePath,
    receiverBindingChain,
    methodName
  ) {
    const receiverIds = new Set(receiverBindingChain);

    return (context.functionsByFile.get(filePath) ?? [])
      .filter(
        (fn) =>
          fn.ownerBindingId &&
          receiverIds.has(fn.ownerBindingId) &&
          !isClassMethod(fn) &&
          getMethodPropertyName(fn) === methodName
      );
  }

  /**
   * Explain why a target could not be established.
   *
   * @param {object} caller
   * @param {object} call
   * @returns {string}
   */
  makeUnresolvedReason(caller, call) {
    if (!call.calleeName || call.calleeName.startsWith("<")) {
      return "dynamic-call-target";
    }

    if (
      call.callKind === "member" ||
      call.callKind === "optional-member" ||
      call.callKind === "dynamic-member"
    ) {
      return "receiver-or-method-target-not-proven";
    }

    if (call.importSource) {
      return "imported-symbol-target-not-found";
    }

    if (call.callKind === "constructor") {
      return "constructor-target-not-proven";
    }

    return "no-matching-lexical-binding";
  }

  /**
   * Return statistics from the most recent resolve() call.
   *
   * @returns {{total:number,resolved:number,ambiguous:number,unresolved:number}}
   */
  getStats() {
    return { ...this.lastStats };
  }
}