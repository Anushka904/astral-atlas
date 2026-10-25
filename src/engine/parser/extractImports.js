/**
 * Import, export, and re-export extraction from Babel ASTs.
 *
 * WHY:
 * - Import edges create the module dependency graph.
 * - Export bindings preserve local symbol aliases.
 * - Re-exports carry the symbol relationship into another module.
 * - All outputs remain plain metadata rather than AST nodes.
 */

import traverse from "./babelTraverse.js";

/**
 * Get a statically known string literal.
 *
 * @param {object|null|undefined} node
 * @returns {string|null}
 */
function getStringLiteral(node) {
  if (!node) {
    return null;
  }

  if (
    node.type === "StringLiteral" ||
    node.type === "Literal"
  ) {
    return typeof node.value === "string"
      ? node.value
      : null;
  }

  return null;
}

/**
 * Get a statically known identifier or literal name.
 *
 * @param {object|null|undefined} node
 * @returns {string|null}
 */
function getName(node) {
  if (!node) {
    return null;
  }

  if (node.type === "Identifier") {
    return node.name;
  }

  if (
    node.type === "StringLiteral" ||
    node.type === "Literal"
  ) {
    return String(node.value);
  }

  return null;
}

/**
 * Return a stable identity for a Babel lexical binding.
 *
 * The same declaration yields the same ID throughout one file. The graph
 * later qualifies this ID with the repository-relative file path.
 *
 * @param {object|null|undefined} binding
 * @returns {string|null}
 */
function bindingIdentity(binding) {
  const identifier = binding?.identifier;

  if (
    !identifier?.name ||
    !identifier.loc?.start
  ) {
    return null;
  }

  return (
    `${identifier.name}@` +
    `${identifier.loc.start.line}:` +
    `${identifier.loc.start.column}`
  );
}

/**
 * Build a compact module dependency record.
 *
 * @param {string} source
 * @param {object} sourceNode
 * @param {string} kind
 * @returns {object}
 */
function makeImport(source, sourceNode, kind) {
  return {
    source,
    kind,
    line: sourceNode.loc?.start.line ?? null,
    importedNames: [],
    localNames: [],
    dynamic: kind === "dynamic",
    typeOnly: false
  };
}

/**
 * Extract statically identifiable module imports.
 *
 * @param {object} ast
 * @returns {object[]}
 */
export function extractImports(ast) {
  const imports = [];
  const seen = new Set();

  function addImport(entry) {
    const key = [
      entry.kind,
      entry.source,
      entry.line
    ].join(":");

    if (!seen.has(key)) {
      seen.add(key);
      imports.push(entry);
    }
  }

  traverse(ast, {
    enter(path) {
      const node = path.node;

      if (node.type === "ImportDeclaration") {
        const source = getStringLiteral(node.source);

        if (source === null) {
          return;
        }

        const entry = makeImport(source, node, "static");
        entry.typeOnly = node.importKind === "type";

        for (const specifier of node.specifiers ?? []) {
          let imported;

          if (specifier.type === "ImportDefaultSpecifier") {
            imported = "default";
          } else if (
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            imported = "*";
          } else {
            imported = getName(specifier.imported);
          }

          const local = getName(specifier.local);

          if (imported !== null) {
            entry.importedNames.push(imported);
          }

          if (local !== null) {
            entry.localNames.push(local);
          }
        }

        addImport(entry);
        return;
      }

      if (
        node.type === "ExportNamedDeclaration" &&
        node.source
      ) {
        const source = getStringLiteral(node.source);

        if (source === null) {
          return;
        }

        const entry = makeImport(source, node, "re-export");
        entry.typeOnly = node.exportKind === "type";

        for (const specifier of node.specifiers ?? []) {
          const imported =
            getName(specifier.local) ??
            getName(specifier.exported);

          const exported = getName(specifier.exported);

          if (imported !== null) {
            entry.importedNames.push(imported);
          }

          if (exported !== null) {
            entry.localNames.push(exported);
          }
        }

        addImport(entry);
        return;
      }

      if (node.type === "ExportAllDeclaration") {
        const source = getStringLiteral(node.source);

        if (source !== null) {
          const entry = makeImport(
            source,
            node,
            "re-export-all"
          );

          entry.importedNames.push("*");
          addImport(entry);
        }

        return;
      }

      if (node.type === "ImportExpression") {
        const source = getStringLiteral(node.source);

        if (source !== null) {
          addImport(makeImport(source, node, "dynamic"));
        }

        return;
      }

      if (node.type !== "CallExpression") {
        return;
      }

      // Babel versions/configurations can represent import() as a call.
      if (node.callee?.type === "Import") {
        const source = getStringLiteral(node.arguments?.[0]);

        if (source !== null) {
          addImport(makeImport(source, node, "dynamic"));
        }

        return;
      }

      if (
        node.callee?.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const source = getStringLiteral(node.arguments?.[0]);

        if (source !== null) {
          addImport(makeImport(source, node, "require"));
        }
      }
    }
  });

  return imports;
}

/**
 * Collect names from supported declaration patterns.
 *
 * @param {object|null|undefined} node
 * @returns {string[]}
 */
function collectDeclaredNames(node) {
  if (!node) {
    return [];
  }

  if (node.type === "Identifier") {
    return [node.name];
  }

  if (node.type === "RestElement") {
    return collectDeclaredNames(node.argument);
  }

  if (node.type === "AssignmentPattern") {
    return collectDeclaredNames(node.left);
  }

  if (node.type === "ObjectPattern") {
    return (node.properties ?? []).flatMap((property) => {
      if (!property) {
        return [];
      }

      if (property.type === "RestElement") {
        return collectDeclaredNames(property.argument);
      }

      return collectDeclaredNames(property.value);
    });
  }

  if (node.type === "ArrayPattern") {
    return (node.elements ?? []).flatMap(
      (element) => collectDeclaredNames(element)
    );
  }

  return [];
}

/**
 * Collect names exported by a module.
 *
 * This returns public names, not the local binding identity. Use
 * extractExportBindings() when call-target resolution needs the relationship
 * between a local declaration and its public export name.
 *
 * @param {object} ast
 * @returns {string[]}
 */
export function extractExports(ast) {
  const names = new Set();

  traverse(ast, {
    enter(path) {
      const node = path.node;

      if (node.type === "ExportDefaultDeclaration") {
        names.add("default");

        if (
          node.declaration?.id?.type === "Identifier"
        ) {
          names.add(node.declaration.id.name);
        }

        return;
      }

      if (node.type !== "ExportNamedDeclaration") {
        return;
      }

      for (const specifier of node.specifiers ?? []) {
        const exported = getName(specifier.exported);

        if (exported !== null) {
          names.add(exported);
        }
      }

      const declaration = node.declaration;

      if (
        declaration?.id?.type === "Identifier"
      ) {
        names.add(declaration.id.name);
      }

      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          for (const name of collectDeclaredNames(declarator.id)) {
            names.add(name);
          }
        }
      }
    }
  });

  return [...names].sort();
}

/**
 * Extract relationships from local declarations to module export names.
 *
 * Supported forms include:
 * - export function save() {}
 * - export const save = () => {}
 * - export { internalSave as save }
 * - export default internalSave
 * - export { original as publicName } from "./other.js"
 * - export * from "./other.js"
 *
 * Re-export relationships are represented with kind "re-export"; GraphBuilder
 * associates them with a dependency edge. Local exports carry a binding ID.
 *
 * @param {object} ast
 * @returns {object[]}
 */
export function extractExportBindings(ast) {
  const mappings = [];
  const seen = new Set();

  function add(mapping) {
    const key = [
      mapping.exportedName,
      mapping.localName ?? "",
      mapping.bindingId ?? "",
      mapping.source ?? "",
      mapping.kind
    ].join("\u0000");

    if (!seen.has(key)) {
      seen.add(key);
      mappings.push(mapping);
    }
  }

  function localBinding(name, scope) {
    if (!name || !scope) {
      return null;
    }

    return scope.getBinding(name) ?? null;
  }

  function addLocalExport(exportedName, localName, scope) {
    const binding = localBinding(localName, scope);

    add({
      exportedName,
      localName,
      bindingId: bindingIdentity(binding),
      source: null,
      kind: "local"
    });
  }

  traverse(ast, {
    enter(path) {
      const node = path.node;

      if (node.type === "ExportDefaultDeclaration") {
        const declaration = node.declaration;

        if (declaration?.type === "Identifier") {
          addLocalExport(
            "default",
            declaration.name,
            path.scope
          );
        } else if (
          declaration?.id?.type === "Identifier"
        ) {
          addLocalExport(
            "default",
            declaration.id.name,
            path.scope
          );
        } else {
          add({
            exportedName: "default",
            localName: null,
            bindingId: null,
            source: null,
            kind: "default-expression"
          });
        }

        return;
      }

      if (node.type !== "ExportNamedDeclaration") {
        return;
      }

      if (node.source) {
        const source = getStringLiteral(node.source);

        if (source === null) {
          return;
        }

        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === "ExportNamespaceSpecifier") {
            add({
              exportedName: getName(specifier.exported),
              localName: null,
              bindingId: null,
              source,
              kind: "re-export-all"
            });

            continue;
          }

          add({
            exportedName: getName(specifier.exported),
            localName: getName(specifier.local),
            bindingId: null,
            source,
            kind: "re-export"
          });
        }

        return;
      }

      for (const specifier of node.specifiers ?? []) {
        const localName = getName(specifier.local);
        const exportedName = getName(specifier.exported);

        if (localName && exportedName) {
          addLocalExport(
            exportedName,
            localName,
            path.scope
          );
        }
      }

      const declaration = node.declaration;

      if (
        declaration?.type === "FunctionDeclaration" ||
        declaration?.type === "ClassDeclaration"
      ) {
        if (declaration.id?.name) {
          addLocalExport(
            declaration.id.name,
            declaration.id.name,
            path.scope
          );
        }

        return;
      }

      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          for (const name of collectDeclaredNames(declarator.id)) {
            addLocalExport(name, name, path.scope);
          }
        }
      }
    }
  });

  return mappings;
}