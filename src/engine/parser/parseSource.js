/**
 * Parse JavaScript/TypeScript source into a compact FileInfo summary.
 *
 * The AST is created, traversed, and discarded in this worker-side function.
 * The result contains serializable summaries, not AST nodes or source text.
 */

import { parse } from "@babel/parser";

import FileInfo from "../FileInfo.js";

import {
  extractImports,
  extractExports,
  extractExportBindings
} from "./extractImports.js";

import {
  extractFunctions
} from "./extractFunctions.js";

/**
 * Choose syntax plugins based on the file extension.
 *
 * Plain TypeScript intentionally does not enable JSX because JSX and
 * TypeScript angle-bracket assertions can be syntactically ambiguous.
 *
 * @param {string} path
 * @returns {string[]}
 */
function getParserPlugins(path) {
  const extension =
    path.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? ".js";

  const plugins = [
    "decorators-legacy",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "dynamicImport",
    "importMeta",
    "topLevelAwait",
    "optionalChaining",
    "nullishCoalescingOperator",
    "logicalAssignment",
    "numericSeparator",
    "objectRestSpread"
  ];

  if ([".ts", ".tsx"].includes(extension)) {
    plugins.push("typescript");
  }

  if (
    [".jsx", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)
  ) {
    plugins.push("jsx");
  }

  return [...new Set(plugins)];
}

/**
 * Count physical source lines.
 *
 * @param {string} source
 * @returns {number}
 */
function countLines(source) {
  if (source.length === 0) {
    return 0;
  }

  return source.split(/\r\n|\r|\n/).length -
    (/\r\n$|\r$|\n$/.test(source) ? 1 : 0);
}

/**
 * Normalize Babel errors into serializable records.
 *
 * @param {Array<object>} errors
 * @returns {object[]}
 */
function normalizeParserErrors(errors = []) {
  return errors.map((error) => ({
    message: error.message,
    code: error.code ?? null,
    line: error.loc?.line ?? null,
    column: error.loc?.column ?? null
  }));
}

/**
 * Parse source and extract the data consumed by the atlas.
 *
 * @param {string} source
 * @param {{path?:string,sha?:string|null}} [options]
 * @returns {object}
 */
export function parseSource(source, {
  path = "unknown.js",
  sha = null
} = {}) {
  if (typeof source !== "string") {
    return FileInfo.failed(
      path,
      sha,
      "The source text was not a string."
    ).toJSON();
  }

  let ast;

  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      errorRecovery: true,
      tokens: true,
      attachComment: false,
      createImportExpressions: true,
      plugins: getParserPlugins(path)
    });
  } catch (error) {
    return FileInfo.failed(
      path,
      sha,
      error?.message ?? "Babel could not parse this file."
    ).toJSON();
  }

  try {
    const imports = extractImports(ast);
    const exports = extractExports(ast);
    const exportBindings = extractExportBindings(ast);

    const {
      functions,
      cyclomaticComplexity
    } = extractFunctions(ast);

    const parseErrors = normalizeParserErrors(
      ast.errors ?? []
    );

    let tokenCount = 0;

    for (const token of ast.tokens ?? []) {
      if (token.type?.label !== "eof") {
        tokenCount += 1;
      }
    }

    const summary = new FileInfo({
      path,
      sha,
      loc: countLines(source),
      tokenCount,
      cyclomaticComplexity,
      imports,
      exports,
      exportBindings,
      functions,
      parseStatus:
        parseErrors.length > 0 ? "recovered" : "ok",
      parseErrors,
      warning:
        parseErrors.length > 0
          ? `${parseErrors.length} recoverable parsing warning(s).`
          : null
    });

    return summary.toJSON();
  } catch (error) {
    return FileInfo.failed(
      path,
      sha,
      `AST analysis failed: ${error?.message ?? "Unknown error."}`
    ).toJSON();
  }
}