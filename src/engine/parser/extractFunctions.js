/**
 * Extract function definitions and scope-aware call metadata.
 *
 * WHY:
 * Two functions can share a name while referring to different bindings.
 * This module records Babel's lexical binding identity so CallResolver can
 * match calls to definitions without guessing based on a name alone.
 *
 * Member calls remain unresolved until the resolver has enough receiver
 * information to identify a likely method target.
 */

import traverse from "./babelTraverse.js";
import FunctionInfo from "../FunctionInfo.js";
import { complexityContribution } from "./complexity.js";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod"
]);

/**
 * Create a stable file-local identity for a Babel binding.
 *
 * @param {object|null|undefined} binding
 * @returns {string|null}
 */
function bindingIdentity(binding) {
  const identifier = binding?.identifier;

  if (!identifier?.name || !identifier.loc?.start) {
    return null;
  }

  return (
    `${identifier.name}@` +
    `${identifier.loc.start.line}:` +
    `${identifier.loc.start.column}`
  );
}

/**
 * Return a property name when it is statically known.
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
    node.type === "NumericLiteral"
  ) {
    return String(node.value);
  }

  return null;
}

/**
 * Find a class context without crossing a normal function boundary.
 *
 * Arrow functions retain lexical `this`, so an arrow nested in a method can
 * inherit the class context. A nested normal function cannot safely do so.
 *
 * @param {object} path
 * @returns {{className:string|null,classBindingId:string|null,classExportNames:string[]}|null}
 */
function findClassContext(path) {
  let current = path.parentPath;

  while (current) {
    if (current.isClassDeclaration() || current.isClassExpression()) {
      const classNode = current.node;
      let className = classNode.id?.name ?? null;
      let classBinding = className
        ? current.scope.getBinding(className)
        : null;

      if (
        !className &&
        current.parentPath?.isVariableDeclarator() &&
        current.parentPath.node.id.type === "Identifier"
      ) {
        className = current.parentPath.node.id.name;
        classBinding = current.parentPath.scope.getBinding(className);
      }

      const classExportNames = [];
      let declarationPath = current;

      if (current.parentPath?.isVariableDeclarator()) {
        declarationPath = current.parentPath;

        if (declarationPath.parentPath?.isVariableDeclaration()) {
          declarationPath = declarationPath.parentPath;
        }
      }

      if (declarationPath.parentPath?.isExportNamedDeclaration()) {
        if (className) {
          classExportNames.push(className);
        }
      } else if (
        declarationPath.parentPath?.isExportDefaultDeclaration()
      ) {
        classExportNames.push("default");
      }

      return {
        className,
        classBindingId: bindingIdentity(classBinding),
        classExportNames
      };
    }

    if (
      current.isFunction() &&
      current.node.type !== "ArrowFunctionExpression"
    ) {
      return null;
    }

    current = current.parentPath;
  }

  return null;
}

/**
 * Locate the object binding that owns an ObjectMethod or object-property
 * arrow function, when that object is assigned to a local variable.
 *
 * @param {object} path
 * @returns {string|null}
 */
function findObjectOwnerBindingId(path) {
  let current = path.parentPath;

  while (current) {
    if (current.isFunction() && !current.isArrowFunctionExpression()) {
      return null;
    }

    if (current.isObjectExpression()) {
      const parent = current.parentPath;

      if (
        parent?.isVariableDeclarator() &&
        parent.node.id.type === "Identifier"
      ) {
        return bindingIdentity(
          parent.scope.getBinding(parent.node.id.name)
        );
      }

      if (
        parent?.isAssignmentExpression() &&
        parent.node.left.type === "Identifier"
      ) {
        return bindingIdentity(
          parent.scope.getBinding(parent.node.left.name)
        );
      }

      return null;
    }

    current = current.parentPath;
  }

  return null;
}

/**
 * Choose the most useful name for a function.
 *
 * @param {object} path
 * @param {{className:string|null}} classContext
 * @returns {string}
 */
function getFunctionName(path, classContext) {
  const node = path.node;
  const parent = path.parentPath;

  if (
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod"
  ) {
    const methodName =
      getPropertyName(node.key, node.computed) ??
      "computed-method";

    return classContext?.className
      ? `${classContext.className}.${methodName}`
      : methodName;
  }

  if (node.type === "ObjectMethod") {
    return (
      getPropertyName(node.key, node.computed) ??
      "computed-object-method"
    );
  }

  // Prefer the outer assigned binding for `const outer = function inner()`.
  if (
    parent?.isVariableDeclarator() &&
    parent.node.id.type === "Identifier"
  ) {
    return parent.node.id.name;
  }

  if (
    parent?.isObjectProperty() &&
    parent.node.key
  ) {
    return (
      getPropertyName(parent.node.key, parent.node.computed) ??
      `anonymous@${node.loc?.start.line ?? 1}`
    );
  }

  if (node.type === "FunctionDeclaration" && node.id?.name) {
    return node.id.name;
  }

  if (
    parent?.isAssignmentExpression() &&
    parent.node.left.type === "Identifier"
  ) {
    return parent.node.left.name;
  }

  if (parent?.isExportDefaultDeclaration()) {
    return "default";
  }

  if (node.id?.name) {
    return node.id.name;
  }

  return `anonymous@${node.loc?.start.line ?? 1}`;
}

/**
 * Identify an appropriate binding for a function definition.
 *
 * Method bodies use ownerBindingId instead because a method isn't itself a
 * lexical identifier binding.
 *
 * @param {object} path
 * @returns {string|null}
 */
function getFunctionBindingId(path) {
  const node = path.node;
  const parent = path.parentPath;

  if (
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod" ||
    node.type === "ObjectMethod"
  ) {
    return null;
  }

  if (
    parent?.isVariableDeclarator() &&
    parent.node.id.type === "Identifier"
  ) {
    return bindingIdentity(
      parent.scope.getBinding(parent.node.id.name)
    );
  }

  if (
    parent?.isObjectProperty() &&
    parent.node.key?.type === "Identifier"
  ) {
    return null;
  }

  if (
    parent?.isAssignmentExpression() &&
    parent.node.left.type === "Identifier"
  ) {
    return bindingIdentity(
      parent.scope.getBinding(parent.node.left.name)
    );
  }

  if (node.type === "FunctionDeclaration" && node.id?.name) {
    return bindingIdentity(
      path.scope.getBinding(node.id.name)
    );
  }

  if (node.id?.name) {
    return bindingIdentity(
      path.scope.getBinding(node.id.name)
    );
  }

  return null;
}

/**
 * Return a sequence of binding identities through simple variable aliases.
 *
 * For:
 *   const first = save;
 *   const second = first;
 *   second();
 *
 * the chain can lead back to the binding for save without guessing by name.
 *
 * @param {object|null|undefined} binding
 * @returns {{bindingChain:string[],terminalBinding:object|null,importInfo:object|null}}
 */
function describeBinding(binding) {
  const bindingChain = [];
  const visited = new Set();

  let current = binding;
  let importInfo = null;

  for (let depth = 0; current && depth < 16; depth += 1) {
    const id = bindingIdentity(current);

    if (!id || visited.has(id)) {
      break;
    }

    visited.add(id);
    bindingChain.push(id);

    const bindingPath = current.path;
    const declaration = bindingPath?.node;

    if (
      bindingPath?.isImportSpecifier() ||
      bindingPath?.isImportDefaultSpecifier() ||
      bindingPath?.isImportNamespaceSpecifier()
    ) {
      const importDeclaration = bindingPath.parentPath?.node;
      const source = importDeclaration?.source?.value;

      let importedName = null;
      let importKind = "named";

      if (bindingPath.isImportDefaultSpecifier()) {
        importedName = "default";
        importKind = "default";
      } else if (bindingPath.isImportNamespaceSpecifier()) {
        importedName = "*";
        importKind = "namespace";
      } else {
        importedName = getPropertyName(
          declaration.imported,
          declaration.imported?.type !== "Identifier"
        );
      }

      importInfo = {
        importSource:
          typeof source === "string" ? source : null,
        importedName,
        importKind
      };

      break;
    }

    // Follow only simple identifier assignments. We deliberately don't
    // perform arbitrary data-flow or points-to analysis in this stage.
    if (
      bindingPath?.isVariableDeclarator() &&
      declaration.init?.type === "Identifier"
    ) {
      current = bindingPath.scope.getBinding(
        declaration.init.name
      );

      continue;
    }

    break;
  }

  return {
    bindingChain,
    terminalBinding: current ?? null,
    importInfo
  };
}

/**
 * Determine whether a function is directly exported under one or more names.
 *
 * Do not climb through an enclosing function: nested local functions must not
 * accidentally be marked as module exports.
 *
 * @param {object} path
 * @param {string} name
 * @returns {string[]}
 */
function getDirectExportNames(path, name) {
  if (
    path.node.type === "ClassMethod" ||
    path.node.type === "ClassPrivateMethod" ||
    path.node.type === "ObjectMethod"
  ) {
    return [];
  }

  let current = path.parentPath;

  while (current) {
    if (current.isExportNamedDeclaration()) {
      return name && name !== "default" ? [name] : [];
    }

    if (current.isExportDefaultDeclaration()) {
      return ["default"];
    }

    if (
      current.isFunction() &&
      current.node !== path.node
    ) {
      return [];
    }

    if (
      current.isClassDeclaration() ||
      current.isClassExpression() ||
      current.isObjectMethod()
    ) {
      return [];
    }

    current = current.parentPath;
  }

  return [];
}

/**
 * Describe a receiver and, for `const item = new Store()`, its constructor.
 *
 * @param {object} path
 * @param {object} receiver
 * @returns {object}
 */
function getReceiverMetadata(path, receiver) {
  if (!receiver) {
    return {};
  }

  if (receiver.type === "ThisExpression") {
    const classContext = findClassContext(path);

    return {
      receiverName: "this",
      receiverBindingId: null,
      receiverBindingChain: [],
      receiverKind: "this",
      callerClassName: classContext?.className ?? null,
      callerClassBindingId:
        classContext?.classBindingId ?? null
    };
  }

  if (receiver.type !== "Identifier") {
    return {
      receiverName: null,
      receiverBindingId: null,
      receiverBindingChain: [],
      receiverKind: "expression"
    };
  }

  const binding = path.scope.getBinding(receiver.name);
  const description = describeBinding(binding);

  const result = {
    receiverName: receiver.name,
    receiverBindingId:
      description.bindingChain[0] ?? null,
    receiverBindingChain: description.bindingChain,
    receiverKind: "identifier",
    ...(description.importInfo
      ? {
          receiverImportSource:
            description.importInfo.importSource,
          receiverImportedName:
            description.importInfo.importedName,
          receiverImportKind:
            description.importInfo.importKind
        }
      : {})
  };

  // Resolve simple instance creation such as:
  //   import { Store as Vault } from "./Store.js";
  //   const store = new Vault();
  //   store.save();
  //
  // The class target is still statically inferred, not guaranteed at runtime.
  const declarationPath = binding?.path;
  const initializer = declarationPath?.isVariableDeclarator()
    ? declarationPath.node.init
    : null;

  if (
    initializer?.type === "NewExpression" &&
    initializer.callee?.type === "Identifier"
  ) {
    const classBinding = declarationPath.scope.getBinding(
      initializer.callee.name
    );

    const classDescription = describeBinding(classBinding);

    result.receiverClassBindingChain =
      classDescription.bindingChain;

    if (classDescription.importInfo) {
      result.receiverClassImportSource =
        classDescription.importInfo.importSource;

      result.receiverClassImportedName =
        classDescription.importInfo.importedName;

      result.receiverClassImportKind =
        classDescription.importInfo.importKind;
    } else {
      result.receiverClassName = initializer.callee.name;
    }
  }

  return result;
}

/**
 * Extract a compact call description from an AST call node.
 *
 * @param {object} path
 * @param {object} activeFunction
 * @returns {object|null}
 */
function extractCall(path, activeFunction) {
  const node = path.node;
  const isConstructor = node.type === "NewExpression";
  const callee = node.callee;

  if (!callee) {
    return null;
  }

  if (
    callee.type === "Import" ||
    (
      callee.type === "Identifier" &&
      callee.name === "require"
    )
  ) {
    return null;
  }

  const line = node.loc?.start.line ?? null;
  const column = node.loc?.start.column ?? null;

  if (callee.type === "Identifier") {
    const description = describeBinding(
      path.scope.getBinding(callee.name)
    );

    return {
      calleeName: callee.name,
      line,
      column,
      callKind: isConstructor ? "constructor" : "identifier",
      localBindingId:
        description.bindingChain[0] ?? null,
      bindingChain: description.bindingChain,
      bindingKind:
        description.terminalBinding?.kind ?? null,
      ...(description.importInfo ?? {}),
      callerClassName:
        activeFunction.info.className ?? null,
      callerClassBindingId:
        activeFunction.info.classBindingId ?? null
    };
  }

  if (
    callee.type === "MemberExpression" ||
    callee.type === "OptionalMemberExpression"
  ) {
    const propertyName = getPropertyName(
      callee.property,
      callee.computed
    );

    const receiver = callee.object;
    const receiverMetadata = getReceiverMetadata(
      path,
      receiver
    );

    const isThis =
      receiver?.type === "ThisExpression";

    const isOptional =
      callee.optional === true ||
      node.optional === true;

    return {
      calleeName: propertyName ?? "<computed>",
      propertyName,
      line,
      column,
      callKind: isConstructor
        ? "constructor"
        : propertyName === null
          ? "dynamic-member"
          : isThis
            ? "this-member"
            : isOptional
              ? "optional-member"
              : "member",
      computed: callee.computed === true,
      receiverKind:
        receiverMetadata.receiverKind ?? "expression",
      ...receiverMetadata,
      callerClassName:
        receiverMetadata.callerClassName ??
        activeFunction.info.className ??
        null,
      callerClassBindingId:
        receiverMetadata.callerClassBindingId ??
        activeFunction.info.classBindingId ??
        null
    };
  }

  return {
    calleeName: "<dynamic-expression>",
    line,
    column,
    callKind: isConstructor
      ? "constructor"
      : "dynamic-expression",
    callerClassName:
      activeFunction.info.className ?? null,
    callerClassBindingId:
      activeFunction.info.classBindingId ?? null
  };
}

/**
 * Extract function definitions and call references.
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
        const classContext = findClassContext(path);
        const name = getFunctionName(path, classContext);
        const startLine = node.loc?.start.line ?? 1;
        const endLine = node.loc?.end.line ?? startLine;
        const startColumn = node.loc?.start.column ?? 0;
        const endColumn = node.loc?.end.column ?? 0;

        const functionBindingId = getFunctionBindingId(path);

        const ownerBindingId =
          node.type === "ClassMethod" ||
          node.type === "ClassPrivateMethod"
            ? classContext?.classBindingId ?? null
            : node.type === "ObjectMethod" ||
                path.parentPath?.isObjectProperty()
              ? findObjectOwnerBindingId(path)
              : null;

        const info = new FunctionInfo({
          name,
          id: `${name}@${startLine}:${startColumn}`,
          startLine,
          endLine,
          startColumn,
          endColumn,
          bindingId: functionBindingId,
          exportNames: getDirectExportNames(path, name),
          classExportNames:
            classContext?.classExportNames ?? [],
          className: classContext?.className ?? null,
          classBindingId:
            classContext?.classBindingId ?? null,
          ownerBindingId,
          cyclomaticComplexity: 1,
          calls: [],
          async: node.async === true,
          generator: node.generator === true,
          kind: node.type
        });

        const context = {
          info,
          complexity: 1,
          calls: new Map()
        };

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

        context.info.calls = [...context.calls.values()];

        const active = functionStack.at(-1);

        if (active === context) {
          functionStack.pop();
        } else {
          const index = functionStack.lastIndexOf(context);

          if (index !== -1) {
            functionStack.splice(index, 1);
          }
        }
      }
    },

    enter(path) {
      const node = path.node;

      const contribution = complexityContribution(node);

      if (contribution > 0) {
        fileComplexity += contribution;

        const activeFunction = functionStack.at(-1);

        if (activeFunction) {
          activeFunction.complexity += contribution;
        }
      }

      if (
        node.type !== "CallExpression" &&
        node.type !== "OptionalCallExpression" &&
        node.type !== "NewExpression"
      ) {
        return;
      }

      const activeFunction = functionStack.at(-1);

      if (!activeFunction) {
        return;
      }

      const call = extractCall(path, activeFunction);

      if (!call) {
        return;
      }

      const key = [
        call.line,
        call.column,
        call.callKind,
        call.calleeName
      ].join(":");

      activeFunction.calls.set(key, call);
    }
  });

  return {
    functions,
    cyclomaticComplexity: fileComplexity
  };
}