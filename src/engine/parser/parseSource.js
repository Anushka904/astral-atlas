/**
 * Parse JavaScript/TypeScript source into a compact FileInfo summary.
 *
 * The AST is created, traversed, and discarded in the calling worker.
 * The returned object contains no AST nodes and no source text.
 */

import { parse } from "@babel/parser";

import FileInfo from "../FileInfo.js";
import {
  extractImports,
  extractExports
} from "./extractImports.js";
import { extractFunctions } from "./extractFunctions.js";

/**
 * Determine parser plugins from the source filename.
 *
 * JS and JSX files accept JSX syntax to accommodate repositories which
 * write React components in .js. Plain .ts files intentionally do not
 * enable JSX because it conflicts with TypeScript angle-bracket assertions.
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
 * Empty source is treated as zero lines. A final newline is not treated
 * as an additional code line.
 *
 * @param {string} source
 * @returns {number}
 */
function countLines(source) {
  if (!source.length) {
    return 0;
  }

  return source.split(/\r\n|\r|\n/).length -
    (/\r\n$|\r$|\n$/.test(source) ? 1 : 0);
}

/**
 * Convert Babel parser errors into compact serializable messages.
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
 * Parse source and extract the data used by the atlas.
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

    const {
      functions,
      cyclomaticComplexity
    } = extractFunctions(ast);

    const parseErrors = normalizeParserErrors(
      ast.errors ?? []
    );

    let tokenCount = 0;

    for (const token of ast.tokens ?? []) {
      // Babel includes an EOF token; it isn't a source token.
      if (token.type?.label !== "eof") {
        tokenCount += 1;
      }
    }

    const parseStatus =
      parseErrors.length > 0 ? "recovered" : "ok";

    const summary = new FileInfo({
      path,
      sha,
      loc: countLines(source),
      tokenCount,
      cyclomaticComplexity,
      imports,
      exports,
      functions,
      parseStatus,
      parseErrors,
      warning:
        parseErrors.length > 0
          ? `${parseErrors.length} recoverable parsing warning(s).`
          : null
    });

    // Do not keep references to the full AST after extracting the summary.
    return summary.toJSON();
  } catch (error) {
    return FileInfo.failed(
      path,
      sha,
      `AST analysis failed: ${error?.message ?? "Unknown error."}`
    ).toJSON();
  }
}