/**
 * Rules for the initial cyclomatic-complexity metric.
 *
 * WHY: A consistent metric is easier to cache, compare, explain, and test.
 * This is a deliberate static-analysis convention, not a replacement for
 * every complexity tool's interpretation.
 */

const BRANCHING_NODE_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression"
]);

const LOGICAL_OPERATORS = new Set([
  "&&",
  "||",
  "??"
]);

const LOGICAL_ASSIGNMENT_OPERATORS = new Set([
  "&&=",
  "||=",
  "??="
]);

/**
 * Count the complexity contribution of one AST node.
 *
 * The base score of one is added separately. A switch case contributes
 * only when it has a test; the default case is not counted as a branch.
 *
 * @param {object} node
 * @returns {number}
 */
export function complexityContribution(node) {
  if (!node || typeof node.type !== "string") {
    return 0;
  }

  if (BRANCHING_NODE_TYPES.has(node.type)) {
    return 1;
  }

  if (
    node.type === "SwitchCase" &&
    node.test !== null
  ) {
    return 1;
  }

  if (
    node.type === "LogicalExpression" &&
    LOGICAL_OPERATORS.has(node.operator)
  ) {
    return 1;
  }

  // Babel commonly represents &&=, ||=, and ??= as AssignmentExpression.
  if (
    (
      node.type === "AssignmentExpression" ||
      node.type === "LogicalAssignmentExpression"
    ) &&
    LOGICAL_ASSIGNMENT_OPERATORS.has(node.operator)
  ) {
    return 1;
  }

  // A parameter such as function greet(name = "visitor") adds a path.
  if (node.type === "AssignmentPattern") {
    return 1;
  }

  // Optional access/calls add a possible short-circuit path.
  if (
    (
      node.type === "OptionalMemberExpression" ||
      node.type === "OptionalCallExpression"
    ) &&
    node.optional === true
  ) {
    return 1;
  }

  return 0;
}

/**
 * Calculate file-level cyclomatic complexity from branch contributions.
 *
 * @param {number[]} contributions
 * @returns {number}
 */
export function totalCyclomaticComplexity(contributions) {
  return 1 + contributions.reduce(
    (total, contribution) => total + contribution,
    0
  );
}