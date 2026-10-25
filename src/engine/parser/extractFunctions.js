/**
 * Function and call extraction from Babel ASTs.
 *
 * WHY:
 * The initial call graph records statically visible call names.
 * Later, CallResolver will use scope bindings and module exports to resolve
 * these calls to stable function IDs where the evidence permits it.
 *
 * Calls are not claimed to be fully resolved by this extraction pass.
 */

import traverse from "./babelTraverse.js";

import FunctionInfo from "../FunctionInfo.js";

import {
  complexityContribution
} from "./complexity.js";

/**
 * Get a property name when its value is statically known.
 *
 * @param {object|null|undefined} node
 * @param {boolean} [computed]
 * @returns {string|null}
 */
function getPropertyName(node, computed = false) {
  if (!node) {
    return null;
  }

  if (node.type === "Identifier" && !computed) {
    return node.name;
  }

  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "NumericLiteralTypeAnnotation"
  ) {
    return String(node.value);
  }

  return null;
}

/**
 * Find the closest enclosing class name for a method.
 *
 * @param {object} path
 * @returns {string|null}
 */
function findEnclosingClassName(path) {
  let parent = path.parentPath;

  while (parent) {
    const node = parent.node;

    if (
      node?.type === "ClassDeclaration" ||
      node?.type === "ClassExpression"
    ) {
      return node.id?.name ?? null;
    }

    parent = parent.parentPath;
  }

  return null;
}

/**
 * Give functions stable descriptive names when possible.
 *
 * Names alone are not globally unique. The ID in FunctionInfo also includes
 * the source line; a later cross-file resolver will additionally qualify
 * identities using the containing file path.
 *
 * @param {object} path
 * @returns {string}
 */
function getFunctionName(path) {
  const node = path.node;
  const parent = path.parentPath?.node;

  if (node.id?.name) {
    return node.id.name;
  }

  // A class or object method is itself the function-like AST node.
  if (
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod"
  ) {
    const methodName =
      getPropertyName(node.key, node.computed) ??
      "computed-method";

    const className = findEnclosingClassName(path);

    return className
      ? `${className}.${methodName}`
      : methodName;
  }

  if (node.type === "ObjectMethod") {
    return (
      getPropertyName(node.key, node.computed) ??
      "computed-object-method"
    );
  }

  // Function expressions and arrow functions inherit their name from
  // the variable or property to which they are assigned.
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  ) {
    return parent.id.name;
  }

  if (
    parent?.type === "AssignmentExpression" &&
    parent.left
  ) {
    if (parent.left.type === "Identifier") {
      return parent.left.name;
    }

    if (parent.left.type === "MemberExpression") {
      return (
        getPropertyName(
          parent.left.property,
          parent.left.computed
        ) ?? "assigned-method"
      );
    }
  }

  if (
    parent?.type === "ObjectProperty" ||
    parent?.type === "ClassProperty" ||
    parent?.type === "ClassPrivateProperty"
  ) {
    return (
      getPropertyName(parent.key, parent.computed) ??
      "assigned-property"
    );
  }

  if (parent?.type === "ExportDefaultDeclaration") {
    return "default";
  }

  const line = node.loc?.start.line ?? 1;

  return `anonymous@${line}`;
}

/**
 * Get the statically visible name of a call target.
 *
 * For service.save(), this returns "save". It does not claim that the
 * receiver's runtime identity is known.
 *
 * @param {object|null|undefined} callee
 * @returns {string|null}
 */
function getStaticCalleeName(callee) {
  if (!callee) {
    return null;
  }

  if (callee.type === "Identifier") {
    return callee.name;
  }

  if (
    callee.type === "MemberExpression" ||
    callee.type === "OptionalMemberExpression"
  ) {
    return getPropertyName(
      callee.property,
      callee.computed
    );
  }

  // A function created and invoked immediately has no stable name here.
  if (
    callee.type === "FunctionExpression" ||
    callee.type === "ArrowFunctionExpression"
  ) {
    return null;
  }

  return null;
}

/**
 * Extract functions, individual complexity scores and named call references.
 *
 * @param {object} ast
 * @returns {{
 *   functions:FunctionInfo[],
 *   cyclomaticComplexity:number
 * }}
 */
export function extractFunctions(ast) {
  const functions = [];
  const functionStack = [];
  const contextByNode = new WeakMap();

  let fileComplexity = 1;

  traverse(ast, {
    Function: {
      enter(path) {
        const node = path.node;
        const name = getFunctionName(path);
        const startLine = node.loc?.start.line ?? 1;
        const endLine =
          node.loc?.end.line ?? startLine;

        const info = new FunctionInfo({
          name,
          startLine,
          endLine,
          cyclomaticComplexity: 1,
          calls: [],
          async: node.async === true,
          generator: node.generator === true,
          kind: node.type
        });

        const context = {
          info,
          complexity: 1,
          calls: new Set()
        };

        // Each AST function node owns its own analysis context. This avoids
        // accidentally attributing nested function calls to the parent.
        contextByNode.set(node, context);
        functionStack.push(context);
        functions.push(info);
      },

      exit(path) {
        const context = contextByNode.get(path.node);

        if (!context) {
          return;
        }

        context.info.cyclomaticComplexity =
          context.complexity;

        context.info.calls = [...context.calls].sort();

        const activeContext = functionStack.at(-1);

        if (activeContext === context) {
          functionStack.pop();
        } else {
          // Defensive recovery maintains a usable traversal stack if a
          // future Babel node visitor introduces unexpected nesting.
          const index = functionStack.lastIndexOf(context);

          if (index >= 0) {
            functionStack.splice(index, 1);
          }
        }
      }
    },

    enter(path) {
      const node = path.node;

      const contribution =
        complexityContribution(node);

      if (contribution > 0) {
        fileComplexity += contribution;

        const activeFunction = functionStack.at(-1);

        if (activeFunction) {
          activeFunction.complexity += contribution;
        }
      }

      const isCall =
        node.type === "CallExpression" ||
        node.type === "OptionalCallExpression" ||
        node.type === "NewExpression";

      if (!isCall) {
        return;
      }

      const activeFunction = functionStack.at(-1);

      if (!activeFunction) {
        return;
      }

      const calleeName = getStaticCalleeName(
        node.callee
      );

      if (
        calleeName &&
        calleeName !== "require" &&
        calleeName !== "import"
      ) {
        activeFunction.calls.add(calleeName);
      }
    }
  });

  return {
    functions,
    cyclomaticComplexity: fileComplexity
  };
}