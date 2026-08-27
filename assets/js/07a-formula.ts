// =============================================================================
// FORMULA LANGUAGE — a tiny, safe calculator for per-node rules
// -----------------------------------------------------------------------------
// Most nodes get their value from the standard Cobb-Douglas rule in
// 07-simulation-engine.ts (see docs/GLOSSARY.md for what "Cobb-Douglas" means).
// Some can't be expressed that way: a coverage percentage is one number divided
// by another, a service is capped by the smaller of demand and capacity, a flow
// is split across routes by fixed shares. For those, a node can carry a
// `formula` — a short line of arithmetic written in the CSV, e.g.
//
//     clamp(examinations / traffic, 0, 1)
//     min(treatment_demand, treatment_capacity)
//     attempted_importation * share_air
//     base_price * (1 + price_elasticity * delay(seizure_rate))
//
// This file is the whole language: it turns that text into a tree ("parsing"),
// and later evaluates that tree against the current numbers. It is deliberately
// TINY and CLOSED — no variables, no assignment, no property access, no calling
// into JavaScript. The app opens CSV files people email each other, so a
// formula must never be able to *do* anything; it can only add, subtract,
// multiply, divide, and call four named functions. There is no `eval()` here
// and there never should be.
//
// WHAT THE LANGUAGE HAS
//   • numbers                 12      3.5      .5          (no exponents)
//   • identifiers             traffic  share_air           (a node id or a param id)
//   • operators               +  -  *  /  and parentheses; unary minus (-x)
//   • min(a, b, …)            the smallest of 2 or more values
//   • max(a, b, …)            the largest of 2 or more values
//   • clamp(x, lo, hi)        x held inside a range = min(max(x, lo), hi)
//   • delay(some_id)          that id's value from the PREVIOUS solver sweep,
//                             which is how feedback loops are made well-defined
//                             (a "unit delay" — see the design doc §3.4)
//
// TWO JARGON WORDS, in plain language:
//   • "token"  — one indivisible piece of the text: a number, a name, a bracket.
//     Splitting the text into tokens first ("tokenizing") means the grammar
//     rules below never have to think about spaces or multi-digit numbers.
//   • "AST" (abstract syntax tree) — the parsed shape of the formula. `a + b * c`
//     becomes a "+" node whose right-hand side is a "*" node, so the tree itself
//     records that the multiply happens first. Parsing happens ONCE at load
//     time; the solver then evaluates the cheap little tree on every sweep.
//
// The grammar is read top-down by hand-written functions, one per precedence
// level ("recursive descent" — each function calls the next-tighter-binding one):
//
//     expression → term      (('+' | '-') term)*        loosest
//     term       → unary     (('*' | '/') unary)*
//     unary      → '-' unary | primary                  tightest
//     primary    → number | identifier | call | '(' expression ')'
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   It does not know which identifiers are real node ids or param ids — it just
//   reports the names it saw (`references` / `delayReferences`). Checking those
//   against the loaded map, and checking that a formula only reads nodes it has
//   an incoming edge from, is the data loader's job. That keeps this module
//   dependency-free and unit-testable on its own: it imports nothing.
//
// ERRORS: every problem in the text throws a FormulaError carrying a plain-
// English message and the 0-based character position of the offending token, so
// the loader can say "unexpected ')' in formula for seizures" and point at it.
//
// AT RUNTIME nothing throws. A division by zero yields 0 for that division and
// raises a flag; an unknown input counts as 0 and is listed; a result that ends
// up infinite or NaN comes back as 0 with a flag. The engine surfaces those
// flags in the detail panel's "how this number was calculated" breakdown, which
// is why evaluation also returns every input value it read.
// =============================================================================

// ───── The parsed shape (AST) ────────────────────────────────────────────────
// One variant per kind of thing the language can express. `kind` is the tag the
// evaluator switches on.
export type FormulaAst =
  | { kind: "number"; value: number }
  | { kind: "identifier"; id: string }
  | { kind: "delay"; id: string }
  | { kind: "negate"; operand: FormulaAst }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: FormulaAst; right: FormulaAst }
  | { kind: "call"; fn: "min" | "max" | "clamp"; args: FormulaAst[] };

// A problem with the formula TEXT (never with the numbers — see the header).
// `position` is a 0-based character index into the source string.
export class FormulaError extends Error {
  position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "FormulaError";
    this.position = position;
  }
}

// The result of parsing: the tree plus the names it mentions, ready for the
// loader to validate and for the solver to evaluate over and over.
export interface ParsedFormula {
  source: string;
  ast: FormulaAst;
  // Identifiers read directly (this sweep's values), unique, first-appearance order.
  references: string[];
  // Identifiers read through delay() (previous sweep's values), unique, first-appearance order.
  delayReferences: string[];
}

// The names that can only ever be used as `name(...)`. Reserving them means a
// typo like `min * 2` gets a helpful message instead of being read as a node id
// that then mysteriously doesn't exist.
const FUNCTION_NAMES = ["min", "max", "clamp", "delay"] as const;
type FunctionName = (typeof FUNCTION_NAMES)[number];

function isFunctionName(text: string): text is FunctionName {
  return (FUNCTION_NAMES as readonly string[]).includes(text);
}

// Shared with the panel's formula highlighter (15-detail-panel's paintFormula),
// so that what it colours as a name is exactly what this parser reads as one. A
// highlighter that disagreed with the parser about where a token starts would be
// worse than no highlighter: it would tell a reviewer the wrong thing about the
// rule they are checking.
export function isFormulaFunction(text: string): boolean {
  return isFunctionName(text);
}
export const FORMULA_NUMBER_PATTERN_SOURCE = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
export const FORMULA_IDENTIFIER_PATTERN_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";

// How deeply parentheses / function calls may nest. Formulas people write are a
// handful of levels deep; the cap only exists so a pathological file full of
// "((((((…" can't exhaust the call stack of the recursive parser.
const MAX_NESTING_DEPTH = 64;

// ═════════════════════════════════════════════════════════════════════════════
// 1. TOKENIZER — text → a flat list of pieces
// ═════════════════════════════════════════════════════════════════════════════

type TokenKind = "number" | "identifier" | "operator" | "lparen" | "rparen" | "comma" | "end";

interface Token {
  kind: TokenKind;
  text: string; // exactly as it appeared, for error messages
  value: number; // only meaningful for kind === "number"
  position: number; // 0-based index of the token's first character
}

// Matches a decimal literal at the start of a string: `12`, `3.5`, `3.`, `.5`.
// No exponent form (`1e6`) — nothing in the model needs one, and leaving it out
// keeps the error messages simple.
const NUMBER_PATTERN = new RegExp("^" + FORMULA_NUMBER_PATTERN_SOURCE);
// Identifiers look like CSV ids: a letter or underscore, then letters/digits/underscores.
const IDENTIFIER_PATTERN = new RegExp("^" + FORMULA_IDENTIFIER_PATTERN_SOURCE);

function makeToken(kind: TokenKind, text: string, position: number, value = 0): Token {
  return { kind: kind, text: text, value: value, position: position };
}

// Split the source into tokens. Whitespace is skipped entirely; anything that
// isn't a recognised piece throws straight away.
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    // Whitespace is insignificant — spaces, tabs, newlines all just separate tokens.
    if (/\s/.test(character)) {
      index++;
      continue;
    }

    if (character === "(" || character === ")") {
      tokens.push(makeToken(character === "(" ? "lparen" : "rparen", character, index));
      index++;
      continue;
    }

    if (character === ",") {
      tokens.push(makeToken("comma", character, index));
      index++;
      continue;
    }

    if (character === "+" || character === "-" || character === "*" || character === "/") {
      tokens.push(makeToken("operator", character, index));
      index++;
      continue;
    }

    const rest = source.slice(index);

    const numberMatch = rest.match(NUMBER_PATTERN);
    if (numberMatch) {
      const text = numberMatch[0];
      tokens.push(makeToken("number", text, index, parseFloat(text)));
      index += text.length;
      continue;
    }

    const identifierMatch = rest.match(IDENTIFIER_PATTERN);
    if (identifierMatch) {
      const text = identifierMatch[0];
      tokens.push(makeToken("identifier", text, index));
      index += text.length;
      continue;
    }

    throw new FormulaError("Unexpected character '" + character + "' at position " + index, index);
  }

  // A sentinel "end" token means the parser never has to check for running off
  // the end of the list — it just sees a token it can't use, and reports it.
  tokens.push(makeToken("end", "", source.length));
  return tokens;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. PARSER — tokens → AST
// ═════════════════════════════════════════════════════════════════════════════

// Everything the parse needs to carry along: where we are in the token list,
// how deep we've recursed, and the identifier names collected so far.
interface ParserState {
  tokens: Token[];
  index: number;
  depth: number;
  references: string[];
  delayReferences: string[];
}

// How to name a token in an error message ("end of formula" reads better than "''").
function describeToken(token: Token): string {
  return token.kind === "end" ? "end of formula" : "'" + token.text + "'";
}

function unexpected(token: Token): FormulaError {
  return new FormulaError(
    "Unexpected " + describeToken(token) + " at position " + token.position,
    token.position,
  );
}

function peek(state: ParserState): Token {
  return state.tokens[state.index];
}

function advance(state: ParserState): Token {
  return state.tokens[state.index++];
}

// Consume the next token only if it is the one expected; otherwise complain.
function expect(state: ParserState, kind: TokenKind, description: string): Token {
  const token = peek(state);
  if (token.kind !== kind) {
    throw new FormulaError(
      "Expected " + description + " at position " + token.position,
      token.position,
    );
  }
  return advance(state);
}

// Record an identifier the formula reads. Kept unique and in first-appearance
// order so the detail panel lists inputs in the order they're written.
function noteReference(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

// expression → term (('+' | '-') term)*   — loosest binding, left-associative,
// so `a - b - c` parses as `(a - b) - c`.
function parseExpression(state: ParserState): FormulaAst {
  let left = parseTerm(state);
  for (;;) {
    const token = peek(state);
    if (token.kind === "operator" && (token.text === "+" || token.text === "-")) {
      advance(state);
      const right = parseTerm(state);
      left = { kind: "binary", op: token.text as "+" | "-", left: left, right: right };
    } else {
      return left;
    }
  }
}

// term → unary (('*' | '/') unary)*   — binds tighter than + and -, so
// `a + b * c` multiplies first; also left-associative (`a / b / c` = `(a / b) / c`).
function parseTerm(state: ParserState): FormulaAst {
  let left = parseUnary(state);
  for (;;) {
    const token = peek(state);
    if (token.kind === "operator" && (token.text === "*" || token.text === "/")) {
      advance(state);
      const right = parseUnary(state);
      left = { kind: "binary", op: token.text as "*" | "/", left: left, right: right };
    } else {
      return left;
    }
  }
}

// unary → '-' unary | primary   — binds tightest, so `-a * b` is `(-a) * b`, and
// `2 * -3` is legal (the minus attaches to the 3). Repeats are fine: `--a`.
function parseUnary(state: ParserState): FormulaAst {
  const token = peek(state);
  if (token.kind === "operator" && token.text === "-") {
    advance(state);
    return { kind: "negate", operand: parseNested(state, parseUnary) };
  }
  return parsePrimary(state);
}

// primary → number | identifier | call | '(' expression ')'
function parsePrimary(state: ParserState): FormulaAst {
  const token = advance(state);

  if (token.kind === "number") {
    return { kind: "number", value: token.value };
  }

  if (token.kind === "lparen") {
    const inner = parseNested(state, parseExpression);
    expect(state, "rparen", "')'");
    return inner;
  }

  if (token.kind === "identifier") {
    const followedByCall = peek(state).kind === "lparen";

    if (!followedByCall) {
      // A bare name. Function names are reserved, so `min + 1` is a mistake we
      // can explain rather than a node id nobody will ever find.
      if (isFunctionName(token.text)) {
        throw new FormulaError(
          "Function '" +
            token.text +
            "' must be called with arguments, like " +
            token.text +
            "(…), at position " +
            token.position,
          token.position,
        );
      }
      noteReference(state.references, token.text);
      return { kind: "identifier", id: token.text };
    }

    if (!isFunctionName(token.text)) {
      throw new FormulaError(
        "Unknown function '" + token.text + "' at position " + token.position,
        token.position,
      );
    }
    return parseCall(state, token);
  }

  throw unexpected(token);
}

// Parse the `(…)` part of a function call, given the already-consumed name token.
function parseCall(state: ParserState, nameToken: Token): FormulaAst {
  const name = nameToken.text as FunctionName;

  // delay() is special: its argument is a BARE identifier, never an expression.
  // `delay(a + b)` is meaningless — the solver stores previous-sweep values per
  // node id, not per arbitrary expression — so we reject it in the parser.
  if (name === "delay") {
    expect(state, "lparen", "'(' after delay");
    const argumentTokens = readCallArguments(state, nameToken, /* rawIdentifiersOnly */ true);
    if (argumentTokens.length !== 1) {
      throw new FormulaError("delay() needs exactly 1 argument", nameToken.position);
    }
    const id = (argumentTokens[0] as Token).text;
    noteReference(state.delayReferences, id);
    return { kind: "delay", id: id };
  }

  expect(state, "lparen", "'(' after " + name);
  const args = readCallArguments(state, nameToken, false) as FormulaAst[];

  if (name === "clamp" && args.length !== 3) {
    throw new FormulaError("clamp() needs exactly 3 arguments", nameToken.position);
  }
  if ((name === "min" || name === "max") && args.length < 2) {
    throw new FormulaError(name + "() needs at least 2 arguments", nameToken.position);
  }
  return { kind: "call", fn: name, args: args };
}

// Read `arg, arg, …)` — the opening bracket is already consumed. With
// `rawIdentifiersOnly` each argument must be a single identifier token (that's
// delay's rule) and the tokens themselves are returned; otherwise each argument
// is a full expression. An empty list (`min()`) is allowed here so the caller
// can report a helpful arity message instead of "unexpected ')'".
function readCallArguments(
  state: ParserState,
  nameToken: Token,
  rawIdentifiersOnly: boolean,
): Array<FormulaAst | Token> {
  const args: Array<FormulaAst | Token> = [];

  if (peek(state).kind === "rparen") {
    advance(state);
    return args;
  }

  for (;;) {
    if (rawIdentifiersOnly) {
      const token = peek(state);
      if (token.kind !== "identifier" || isFunctionName(token.text)) {
        throw new FormulaError(
          "delay() needs a plain node or param id, but found " +
            describeToken(token) +
            " at position " +
            token.position,
          token.position,
        );
      }
      advance(state);
      args.push(token);
    } else {
      args.push(parseNested(state, parseExpression));
    }

    const next = peek(state);
    if (next.kind === "comma") {
      advance(state);
      continue;
    }
    if (next.kind === "rparen") {
      advance(state);
      return args;
    }
    // In delay's bare-identifier mode, anything other than `)` here means the
    // author wrote an expression (`delay(a + b)`), so say so in delay's terms
    // rather than the generic "expected a comma" message.
    throw new FormulaError(
      rawIdentifiersOnly
        ? "delay() needs a plain node or param id, but found " +
            describeToken(next) +
            " at position " +
            next.position
        : "Expected ',' or ')' in " + nameToken.text + "() at position " + next.position,
      next.position,
    );
  }
}

// Run one sub-parse a level deeper, with the depth guard applied.
function parseNested(state: ParserState, parse: (state: ParserState) => FormulaAst): FormulaAst {
  state.depth++;
  if (state.depth > MAX_NESTING_DEPTH) {
    const token = peek(state);
    throw new FormulaError(
      "Formula is nested too deeply (limit " +
        MAX_NESTING_DEPTH +
        ") at position " +
        token.position,
      token.position,
    );
  }
  const result = parse(state);
  state.depth--;
  return result;
}

// Turn formula text into a ParsedFormula. Throws FormulaError on ANY problem —
// callers do this once, at load time, and keep the result.
export function parseFormula(source: string): ParsedFormula {
  const text = typeof source === "string" ? source : "";
  if (text.trim() === "") {
    throw new FormulaError("Formula is empty", 0);
  }

  const state: ParserState = {
    tokens: tokenize(text),
    index: 0,
    depth: 0,
    references: [],
    delayReferences: [],
  };

  const ast = parseExpression(state);

  // Anything left over means two expressions were jammed together (`1 2`) or a
  // bracket was closed too often (`(1)) `).
  const trailing = peek(state);
  if (trailing.kind !== "end") throw unexpected(trailing);

  return {
    source: text,
    ast: ast,
    references: state.references,
    delayReferences: state.delayReferences,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. EVALUATOR — AST + current numbers → a value (plus a full audit trail)
// ═════════════════════════════════════════════════════════════════════════════

// What the evaluator is allowed to ask the outside world. The solver supplies
// both: `lookup` reads this sweep's values, `lookupDelayed` reads the previous
// sweep's (that's what makes delay() a unit delay). `undefined` means "no such
// value" — an unknown id, or a node with no baseline.
export interface FormulaEvalContext {
  lookup(id: string): number | undefined;
  lookupDelayed(id: string): number | undefined;
}

export interface FormulaEvalResult {
  // Always a finite number — see `nonFinite` for when that took a fallback.
  value: number;
  // Every input actually read, unique per (id, delayed), in first-use order.
  // This is what the detail panel's "how this number was calculated" list shows.
  inputs: { id: string; value: number; delayed: boolean }[];
  // A divisor was 0 somewhere; that division produced 0 and evaluation continued.
  dividedByZero: boolean;
  // The final result came out Infinity or NaN, so `value` was forced to 0.
  nonFinite: boolean;
  // Ids whose lookup returned undefined. Each was treated as 0.
  missingInputs: string[];
}

// Scratch state threaded through the recursive walk.
interface EvalState {
  ctx: FormulaEvalContext;
  inputs: { id: string; value: number; delayed: boolean }[];
  dividedByZero: boolean;
  missingInputs: string[];
}

// Read one identifier, from this sweep or the previous one, recording what we
// found (or didn't) for the audit trail.
function readInput(state: EvalState, id: string, delayed: boolean): number {
  const raw = delayed ? state.ctx.lookupDelayed(id) : state.ctx.lookup(id);
  const resolved = raw === undefined ? 0 : raw;

  if (raw === undefined && !state.missingInputs.includes(id)) {
    state.missingInputs.push(id);
  }

  // One entry per (id, delayed) pair: `x + delay(x)` legitimately lists two
  // different readings of the same id, but `x + x` lists it once.
  const alreadyListed = state.inputs.some((input) => input.id === id && input.delayed === delayed);
  if (!alreadyListed) {
    state.inputs.push({ id: id, value: resolved, delayed: delayed });
  }
  return resolved;
}

function evaluateNode(node: FormulaAst, state: EvalState): number {
  switch (node.kind) {
    case "number":
      return node.value;

    case "identifier":
      return readInput(state, node.id, false);

    case "delay":
      return readInput(state, node.id, true);

    case "negate":
      return -evaluateNode(node.operand, state);

    case "binary": {
      const left = evaluateNode(node.left, state);
      const right = evaluateNode(node.right, state);
      if (node.op === "+") return left + right;
      if (node.op === "-") return left - right;
      if (node.op === "*") return left * right;
      // Division by zero: the map is full of ratios like examinations / traffic,
      // and a zero denominator is a data situation, not a crash. Yield 0, raise
      // the flag so the trace can say so, and carry on evaluating the rest.
      if (right === 0) {
        state.dividedByZero = true;
        return 0;
      }
      return left / right;
    }

    case "call": {
      const values = node.args.map((argument) => evaluateNode(argument, state));
      if (node.fn === "min") return Math.min(...values);
      if (node.fn === "max") return Math.max(...values);
      // clamp(x, lo, hi) — hold x inside a range. Written out rather than via
      // Math.min/Math.max nesting so the intent is obvious.
      return Math.min(Math.max(values[0], values[1]), values[2]);
    }
  }
}

// ───── Fast path: the same maths with no audit trail ────────────────────────
// The solver sweeps every formula box dozens of times per slider tick and only
// ever reads `.value`. Building the inputs / missingInputs bookkeeping for those
// runs was pure waste — an array push per identifier plus an O(k²) `.some()`
// dedupe and an `includes()` scan, thousands of times a frame. This walk does
// the arithmetic ONLY: no EvalState, no allocations at all beyond the recursion.
//
// It must agree with evaluateNode() digit for digit; the two differ only in what
// they record. The min/max loops below replace Math.min(...args) (which
// allocates an argument array per call) but keep its NaN behaviour explicitly.
export function evaluateFormulaValue(parsed: ParsedFormula, ctx: FormulaEvalContext): number {
  const raw = evaluateValueOnly(parsed.ast, ctx);
  return Number.isFinite(raw) ? raw : 0;
}

function evaluateValueOnly(node: FormulaAst, ctx: FormulaEvalContext): number {
  switch (node.kind) {
    case "number":
      return node.value;

    case "identifier": {
      const value = ctx.lookup(node.id);
      return value === undefined ? 0 : value;
    }

    case "delay": {
      const value = ctx.lookupDelayed(node.id);
      return value === undefined ? 0 : value;
    }

    case "negate":
      return -evaluateValueOnly(node.operand, ctx);

    case "binary": {
      const left = evaluateValueOnly(node.left, ctx);
      const right = evaluateValueOnly(node.right, ctx);
      if (node.op === "+") return left + right;
      if (node.op === "-") return left - right;
      if (node.op === "*") return left * right;
      // Division by zero yields 0 here too (the traced path also raises a flag,
      // which only the detail panel needs).
      if (right === 0) return 0;
      return left / right;
    }

    case "call": {
      const args = node.args;
      if (node.fn === "clamp") {
        const x = evaluateValueOnly(args[0], ctx);
        const lo = evaluateValueOnly(args[1], ctx);
        const hi = evaluateValueOnly(args[2], ctx);
        return Math.min(Math.max(x, lo), hi);
      }
      // min / max over 2+ arguments, without the spread's argument array.
      let accumulator = evaluateValueOnly(args[0], ctx);
      if (accumulator !== accumulator) return NaN;   // NaN in → NaN out, as Math.min does
      const wantSmallest = node.fn === "min";
      for (let i = 1; i < args.length; i++) {
        const value = evaluateValueOnly(args[i], ctx);
        if (value !== value) return NaN;
        if (wantSmallest ? value < accumulator : value > accumulator) accumulator = value;
      }
      return accumulator;
    }
  }
}

// Evaluate a parsed formula against the current numbers. NEVER throws: every
// numeric mishap becomes a flag on the result, so the solver can keep sweeping
// and the UI can explain what happened.
//
// This is the TRACED path: it records every input it read, so the detail panel
// can show the working. The solver uses evaluateFormulaValue() instead.
export function evaluateFormula(parsed: ParsedFormula, ctx: FormulaEvalContext): FormulaEvalResult {
  const state: EvalState = {
    ctx: ctx,
    inputs: [],
    dividedByZero: false,
    missingInputs: [],
  };

  const raw = evaluateNode(parsed.ast, state);
  const finite = Number.isFinite(raw);

  return {
    value: finite ? raw : 0,
    inputs: state.inputs,
    dividedByZero: state.dividedByZero,
    nonFinite: !finite,
    missingInputs: state.missingInputs,
  };
}
