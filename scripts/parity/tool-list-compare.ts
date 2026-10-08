// Compare two `tools/list` payloads by meaning, not by bytes (#292; the rules below are those of
// ADR-0031 (second-implementation-matches-tool-list-by-meaning) Decision 2). The `.snap` file stays the
// byte-exact guard on the TypeScript server (src/tool-list.test.ts, ADR-0016); another server is
// judged on what its schemas accept, so it needn't copy how zod happens to write them.
//
// Both sides go through normalizeSchema, a pure function. It removes only what no client can see
// in validation:
//   1. `$ref` is replaced by the schema it points at (`#/$defs/...` or `#/definitions/...`), and
//      `$defs` / `definitions` are dropped. Where a definition lives doesn't change what it accepts.
//      A `$ref` with sibling keywords, and an `allOf` of one schema, are merged into one schema,
//      since both mean "this schema and these keywords" (schemars writes a described enum as
//      `allOf: [{$ref}]` plus `description`). If a key clashes, both stay as an `allOf`, and differ.
//   2. A top-level argument (a key of the input schema's root `properties`) that is not in
//      `required` and also accepts null (`type: [T, "null"]`, a `{type: "null"}` branch of
//      `anyOf` / `oneOf`, or `null` in `enum`) loses the null. The TypeScript server drops a
//      top-level null before parsing (`withoutNulls` in src/utils/parse-args.ts), so there null and
//      absent are the same argument, as with `Option<T>`. Anywhere else the null stays and counts:
//      in a nested object zod rejects null, and a required argument's null is meaning.
//   3. `$schema`, `format` and `title` keywords are dropped. `$schema` names the draft, not a rule.
//      `format` is an annotation by default in JSON Schema 2020-12, and the values schemars writes
//      (`uint32`, `double`) aren't registered formats. `title` is a label. These are keywords of a
//      schema only: a property *named* format or title is kept, and so are the tool's title and
//      annotations, which are compared exactly.
//   4. Numbers are compared by value: `50`, `50.0` and `5e1` all parse to the same number.
//   5. `required` is sorted, and object keys never matter (objects are compared key by key).
//
// Everything else is compared exactly: tool names, titles, annotations and descriptions, and in
// each schema the types, `required`, enum values (in order), bounds, defaults, descriptions and
// `additionalProperties`.

/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = [
  'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems',
  'contains', 'propertyNames', 'not', 'if', 'then', 'else'
];
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas'];
/** Keywords that don't affect validation (rules 1 and 3). */
const DROPPED_KEYWORDS = new Set(['$schema', '$defs', 'definitions', 'format', 'title']);

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, to tell whether two values are equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v
  );
}

/** Both schemas as one; an `allOf` of the two if any key holds different values. */
function merge(a: Schema, b: Schema): Schema {
  const out: Schema = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key in out && stable(out[key]) !== stable(value)) return { allOf: [a, b] };
    out[key] = value;
  }
  return out;
}

/** The schema a local JSON pointer (`#/$defs/Name`) names. */
function resolvePointer(root: Schema, ref: string): unknown {
  // Only `#` and `#/...` are JSON pointers; an anchor (`#Foo`) or another document can't be resolved here
  if (ref !== '#' && !ref.startsWith('#/')) throw new Error(`can't resolve $ref ${JSON.stringify(ref)}: only local JSON pointers are supported`);
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !(part in node)) throw new Error(`$ref ${JSON.stringify(ref)} points at nothing`);
    node = node[part];
  }
  return node;
}

const isNullSchema = (s: unknown): boolean =>
  isObject(s) &&
  ((s.type === 'null' && Object.keys(s).length === 1) ||
    ('const' in s && s.const === null && Object.keys(s).length === 1) ||
    (Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === null && Object.keys(s).length === 1));

/** An optional property's schema without the null it also accepts (rule 2). */
function withoutNull(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  let s: Schema = { ...schema };
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const rest = s.type.filter(t => t !== 'null');
    s.type = rest.length === 1 ? rest[0] : rest;
  }
  if (Array.isArray(s.enum) && s.enum.includes(null)) s.enum = s.enum.filter(v => v !== null);
  for (const key of ['anyOf', 'oneOf']) {
    const branches = s[key];
    if (!Array.isArray(branches) || !branches.some(isNullSchema)) continue;
    const rest = branches.filter(b => !isNullSchema(b));
    if (rest.length === 1 && isObject(rest[0])) {
      delete s[key];
      s = merge(s, rest[0]);
    } else {
      s[key] = rest;
    }
  }
  return s;
}

function normalizeNode(node: unknown, root: Schema, refs: readonly string[]): unknown {
  if (!isObject(node)) return node;

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (refs.includes(ref)) throw new Error(`$ref ${JSON.stringify(ref)} is recursive; the harness can't compare it`);
    const target = normalizeNode(resolvePointer(root, ref), root, [...refs, ref]);
    const { $ref: _ref, ...siblings } = node;
    const rest = normalizeNode(siblings, root, refs);
    return isObject(target) && isObject(rest) ? merge(target, rest) : target;
  }

  let out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (SCHEMA_KEYWORDS.includes(key)) out[key] = normalizeNode(value, root, refs);
    else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) out[key] = value.map(v => normalizeNode(v, root, refs));
    else if (key === 'items') out[key] = Array.isArray(value) ? value.map(v => normalizeNode(v, root, refs)) : normalizeNode(value, root, refs);
    else if (SCHEMA_MAP_KEYWORDS.includes(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, v]) => [name, normalizeNode(v, root, refs)]));
    } else out[key] = value;
  }

  if (Array.isArray(out.required)) out.required = [...out.required].sort();
  if (Array.isArray(out.allOf) && out.allOf.length === 1 && isObject(out.allOf[0])) {
    const { allOf, ...rest } = out;
    out = merge(allOf[0] as Schema, rest);
  }
  return out;
}

/** A JSON Schema with the quirks above taken out, so equal meaning gives equal values. Pure. */
export function normalizeSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const out = normalizeNode(schema, schema, []);
  // Rule 2, for top-level arguments only
  if (!isObject(out) || !isObject(out.properties)) return out;
  const required = new Set(Array.isArray(out.required) ? out.required : []);
  return {
    ...out,
    properties: Object.fromEntries(
      Object.entries(out.properties).map(([name, v]) => [name, required.has(name) ? v : withoutNull(v)])
    )
  };
}

/** The fields of a tool the harness compares, in the shape of the snapshot (tool-list-projection). */
export interface ProjectedTool {
  name: string;
  title?: string;
  annotations?: unknown;
  description?: string;
  inputSchema: unknown;
}

/** Each place two values differ, as `path: expected ..., got ...` lines. */
export function valueDifferences(path: string, expected: unknown, actual: unknown): string[] {
  const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));
  if (isObject(expected) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap(k => valueDifferences(`${path}.${k}`, expected[k], actual[k]));
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return [`${path}: expected ${show(expected)}, got ${show(actual)}`];
    return expected.flatMap((v, i) => valueDifferences(`${path}[${i}]`, v, actual[i]));
  }
  return expected === actual ? [] : [`${path}: expected ${show(expected)}, got ${show(actual)}`];
}

/**
 * Compare a server's tools with the reference by meaning: tools matched by name, every field
 * exact except the input schema, which is compared after {@link normalizeSchema}.
 */
export function compareToolLists(expected: readonly ProjectedTool[], actual: readonly ProjectedTool[]): string[] {
  const byName = (tools: readonly ProjectedTool[]) => new Map(tools.map(t => [t.name, t]));
  const want = byName(expected);
  const got = byName(actual);
  const failures: string[] = [];
  for (const name of [...new Set([...want.keys(), ...got.keys()])].sort()) {
    const w = want.get(name);
    const g = got.get(name);
    if (!g) failures.push(`${name}: missing`);
    else if (!w) failures.push(`${name}: not in the reference`);
    else {
      try {
        failures.push(
          ...valueDifferences(name, { ...w, inputSchema: normalizeSchema(w.inputSchema) }, { ...g, inputSchema: normalizeSchema(g.inputSchema) })
        );
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    }
  }
  return failures;
}
