/**
 * Normalize the @babel/traverse export across module environments.
 *
 * WHY:
 * Node's CommonJS interoperability and Vite's bundling can expose a
 * package's default export differently. Centralizing normalization avoids
 * having each AST extraction module handle that difference independently.
 */

import * as BabelTraverseNamespace from "@babel/traverse";

const candidates = [
  BabelTraverseNamespace.default?.default,
  BabelTraverseNamespace.default,
  BabelTraverseNamespace.traverse
];

const traverse = candidates.find(
  (candidate) => typeof candidate === "function"
);

if (!traverse) {
  throw new TypeError(
    "Could not find the Babel traverse function. Check the installed @babel/traverse version and its module exports."
  );
}

export default traverse;