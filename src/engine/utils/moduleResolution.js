/**
 * Static JavaScript/TypeScript import resolution.
 *
 * WHY: Resolution must be deterministic and independent of React and
 * Cytoscape. The same resolver is used by tests and graph construction.
 */

const EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json"
];

/**
 * Normalize dot segments while preventing paths escaping the repo root.
 *
 * Internal ".." segments are allowed because relative imports can use them.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeModulePath(input) {
  if (typeof input !== "string" || !input) {
    return null;
  }

  const normalized = input.replace(/\\/g, "/");

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return null;
  }

  const result = [];

  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (result.length === 0) {
        return null;
      }

      result.pop();
      continue;
    }

    result.push(segment);
  }

  return result.join("/");
}

/**
 * Join repository-relative paths without accidentally creating an
 * absolute path when the base directory is the repository root.
 *
 * @param {...string} parts
 * @returns {string|null}
 */
function joinRepoPaths(...parts) {
  const nonEmpty = parts.filter(
    (part) => typeof part === "string" && part.length > 0
  );

  return normalizeModulePath(nonEmpty.join("/"));
}

/**
 * Remove JSON comments without removing comment-like text inside strings.
 *
 * @param {string} source
 * @returns {string}
 */
function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }

      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        blockComment = false;
      } else {
        result += char === "\n" || char === "\r"
          ? char
          : " ";
      }

      continue;
    }

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 1;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Remove trailing commas outside JSON strings.
 *
 * @param {string} source
 * @returns {string}
 */
function removeTrailingCommas(source) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let nextIndex = index + 1;

      while (
        nextIndex < source.length &&
        /\s/.test(source[nextIndex])
      ) {
        nextIndex += 1;
      }

      if (
        source[nextIndex] === "}" ||
        source[nextIndex] === "]"
      ) {
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Parse tsconfig/jsconfig JSON or JSONC input.
 *
 * The returned baseUrl is relative to the repository root.
 * This function does not follow a configuration file's "extends" chain.
 *
 * @param {string|object|null} input
 * @param {{configPath?:string}} [options]
 * @returns {{
 *   baseUrl:string,
 *   paths:Record<string,string[]>,
 *   isTypeScriptProject:boolean,
 *   configPath:string|null
 * }}
 */
export function parsePathConfig(
  input,
  { configPath = "tsconfig.json" } = {}
) {
  if (!input) {
    return {
      baseUrl: "",
      paths: {},
      isTypeScriptProject: false,
      configPath: null
    };
  }

  let config;

  try {
    if (typeof input === "string") {
      config = JSON.parse(
        removeTrailingCommas(
          stripJsonComments(input)
        )
      );
    } else if (
      typeof input === "object" &&
      !Array.isArray(input)
    ) {
      config = input;
    } else {
      throw new TypeError(
        "Configuration must be JSON/JSONC text or a configuration object."
      );
    }
  } catch (error) {
    throw new Error(
      `Could not parse ${configPath}: ${error.message}`,
      { cause: error }
    );
  }

  const compilerOptions = config.compilerOptions ?? {};
  const slash = configPath.lastIndexOf("/");

  const configDir = slash === -1
    ? ""
    : normalizeModulePath(configPath.slice(0, slash));

  if (configDir === null) {
    throw new Error(
      `Invalid repository-relative configuration path: ${configPath}`
    );
  }

  const rawBaseUrl =
    typeof compilerOptions.baseUrl === "string"
      ? compilerOptions.baseUrl
      : ".";

  const baseUrl = joinRepoPaths(
    configDir,
    rawBaseUrl
  );

  if (baseUrl === null) {
    throw new Error(
      `The baseUrl in ${configPath} escapes the repository root.`
    );
  }

  const paths = {};

  for (const [alias, targets] of Object.entries(
    compilerOptions.paths ?? {}
  )) {
    if (
      typeof alias !== "string" ||
      !Array.isArray(targets)
    ) {
      continue;
    }

    paths[alias] = targets.filter(
      (target) => typeof target === "string"
    );
  }

  return {
    baseUrl,
    paths,
    isTypeScriptProject:
      configPath.toLowerCase().endsWith("tsconfig.json") ||
      Boolean(compilerOptions.types) ||
      Boolean(compilerOptions.typeRoots) ||
      Object.hasOwn(compilerOptions, "paths"),
    configPath
  };
}

/**
 * Derive the package name for a bare module specifier.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function getExternalPackageName(specifier) {
  if (specifier.startsWith("node:")) {
    return specifier;
  }

  const parts = specifier.split("/");

  if (specifier.startsWith("@")) {
    return parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : specifier;
  }

  return parts[0];
}

/**
 * Generate possible file paths for a module base path.
 *
 * @param {string} basePath
 * @param {boolean} isTypeScriptProject
 * @returns {string[]}
 */
function makeCandidates(basePath, isTypeScriptProject) {
  const normalized = normalizeModulePath(basePath);

  if (normalized === null) {
    return [];
  }

  const extensionMatch = normalized.match(/\.[^./]+$/);
  const candidates = [];

  function add(candidate) {
    const path = normalizeModulePath(candidate);

    if (path !== null && !candidates.includes(path)) {
      candidates.push(path);
    }
  }

  if (extensionMatch) {
    add(normalized);

    const extension = extensionMatch[0].toLowerCase();

    if (isTypeScriptProject && extension === ".js") {
      const stem = normalized.slice(0, -3);

      add(`${stem}.ts`);
      add(`${stem}.tsx`);
      add(`${stem}.jsx`);
    }

    return candidates;
  }

  add(normalized);

  for (const extension of EXTENSIONS) {
    add(`${normalized}${extension}`);
  }

  for (const extension of EXTENSIONS) {
    add(`${normalized}/index${extension}`);
  }

  return candidates;
}

/**
 * Expand tsconfig/jsconfig aliases into repository-relative base paths.
 *
 * @param {string} specifier
 * @param {object} pathConfig
 * @returns {string[]}
 */
function makeAliasBases(specifier, pathConfig) {
  const bases = [];

  const aliases = Object.keys(pathConfig.paths ?? {})
    .sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const wildcardIndex = alias.indexOf("*");
    let captured = "";

    if (wildcardIndex === -1) {
      if (specifier !== alias) {
        continue;
      }
    } else {
      const prefix = alias.slice(0, wildcardIndex);
      const suffix = alias.slice(wildcardIndex + 1);

      if (
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix) ||
        specifier.length < prefix.length + suffix.length
      ) {
        continue;
      }

      captured = specifier.slice(
        prefix.length,
        specifier.length - suffix.length
      );
    }

    for (const target of pathConfig.paths[alias] ?? []) {
      const expandedTarget = target.replace("*", captured);

      const base = joinRepoPaths(
        pathConfig.baseUrl ?? "",
        expandedTarget
      );

      if (base !== null) {
        bases.push(base);
      }
    }
  }

  return bases;
}

/**
 * Resolve a static import against the available repository paths.
 *
 * @param {string} importerPath
 * @param {string|object} importSpecifier
 * @param {Set<string>|string[]} availablePaths
 * @param {object} [rawPathConfig]
 * @returns {object}
 */
export function resolveModuleSpecifier(
  importerPath,
  importSpecifier,
  availablePaths,
  rawPathConfig = {}
) {
  const specifier = typeof importSpecifier === "string"
    ? importSpecifier
    : importSpecifier?.source;

  if (
    typeof importerPath !== "string" ||
    typeof specifier !== "string" ||
    !specifier.trim()
  ) {
    return {
      status: "unresolved",
      kind: "unresolved",
      specifier: String(specifier ?? ""),
      reason: "invalid-import"
    };
  }

  const paths = availablePaths instanceof Set
    ? availablePaths
    : new Set(availablePaths ?? []);

  const pathConfig = rawPathConfig?.paths
    ? rawPathConfig
    : parsePathConfig(rawPathConfig);

  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/")
  ) {
    if (specifier.startsWith("/")) {
      return {
        status: "unresolved",
        kind: "unresolved",
        specifier,
        reason: "root-absolute-imports-are-not-supported"
      };
    }

    const slash = importerPath.lastIndexOf("/");

    const importerDir = slash === -1
      ? ""
      : importerPath.slice(0, slash);

    const base = joinRepoPaths(
      importerDir,
      specifier
    );

    if (base === null) {
      return {
        status: "unresolved",
        kind: "unresolved",
        specifier,
        reason: "path-escapes-repository-root"
      };
    }

    const candidates = makeCandidates(
      base,
      pathConfig.isTypeScriptProject === true
    );

    const targetPath = candidates.find(
      (candidate) => paths.has(candidate)
    );

    if (targetPath) {
      return {
        status: "resolved",
        kind: "internal",
        specifier,
        targetPath,
        candidates
      };
    }

    return {
      status: "unresolved",
      kind: "unresolved",
      specifier,
      reason: "relative-target-not-found-in-analysis",
      candidates
    };
  }

  const aliasBases = makeAliasBases(
    specifier,
    pathConfig
  );

  const aliasCandidates = aliasBases.flatMap(
    (base) => makeCandidates(
      base,
      pathConfig.isTypeScriptProject === true
    )
  );

  const aliasTarget = aliasCandidates.find(
    (candidate) => paths.has(candidate)
  );

  if (aliasTarget) {
    return {
      status: "resolved",
      kind: "internal",
      specifier,
      targetPath: aliasTarget,
      candidates: aliasCandidates
    };
  }

  if (aliasBases.length > 0) {
    return {
      status: "unresolved",
      kind: "unresolved",
      specifier,
      reason: "configured-alias-target-not-found",
      candidates: aliasCandidates
    };
  }

  return {
    status: "external",
    kind: "external",
    specifier,
    packageName: getExternalPackageName(specifier)
  };
}