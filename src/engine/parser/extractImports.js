/**
 * Import and export extraction from Babel ASTs.
 *
 * WHY:
 * Import edges create the file dependency graph. Re-exports also establish
 * dependencies because an exported symbol may originate in another module.
 *
 * This module returns serializable metadata, never AST nodes.
 */

import traverse from "./babelTraverse.js";

/**
 * Return a statically known string value.
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
 * Convert a statically known identifier or literal to a string.
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
 * Construct a compact dependency record.
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
 * Extract module references statically identifiable in the AST.
 *
 * Supported forms:
 * - import ... from "module"
 * - export ... from "module"
 * - import("module")
 * - require("module")
 *
 * Dynamic expressions such as import("./modules/" + name) are intentionally
 * excluded because the target cannot be identified from the string alone.
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

        const entry = makeImport(
          source,
          node,
          "static"
        );

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

        const entry = makeImport(
          source,
          node,
          "re-export"
        );

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
          addImport(
            makeImport(source, node, "dynamic")
          );
        }

        return;
      }

      // Some Babel AST configurations represent import() as a CallExpression.
      if (node.type !== "CallExpression") {
        return;
      }

      if (node.callee?.type === "Import") {
        const source = getStringLiteral(
          node.arguments?.[0]
        );

        if (source !== null) {
          addImport(
            makeImport(source, node, "dynamic")
          );
        }

        return;
      }

      if (
        node.callee?.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const source = getStringLiteral(
          node.arguments?.[0]
        );

        if (source !== null) {
          addImport(
            makeImport(source, node, "require")
          );
        }
      }
    }
  });

  return imports;
}

/**
 * Collect names declared by identifier and destructuring patterns.
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
 * Extract names exported by a module.
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

        const declaration = node.declaration;

        if (
          declaration?.id?.type === "Identifier" &&
          declaration.id.name
        ) {
          names.add(declaration.id.name);
        }

        return;
      }

      if (node.type === "ExportNamedDeclaration") {
        for (const specifier of node.specifiers ?? []) {
          const exported = getName(specifier.exported);

          if (exported !== null) {
            names.add(exported);
          }
        }

        const declaration = node.declaration;

        if (
          declaration?.id?.type === "Identifier" &&
          declaration.id.name
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

      if (node.type === "ExportAllDeclaration") {
        names.add("*");
      }
    }
  });

  return [...names].sort();
}