//! What every tool shares: the read-only hints, the input schema generated from its argument
//! type, argument parsing at the boundary, and turning a tool's outcome into the TypeScript
//! server's results. A tool's own code is in its directory under `tools/`.

use std::sync::Arc;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, ToolAnnotations};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::errors::ToolError;
use crate::meta::ambiguous_page_result;

/// Hints shared by every tool: each only reads from one known local LogSeq (BR-0002).
pub fn read_only_annotations(title: &str) -> ToolAnnotations {
    ToolAnnotations::with_title(title).read_only(true).destructive(false).idempotent(true).open_world(false)
}

/// A tool's `inputSchema`, generated from the type its arguments are parsed into, so the two
/// can't drift apart (ADR-0019). The schema is schemars' own (draft 2020-12, `$defs` and `$ref`
/// for enums, `null` in an `Option`'s type, `format` on numbers). The parity harness compares
/// schemas by meaning (#292), so zod's serialization isn't copied, only the contract:
/// - the top-level `title` and `description` (the Rust type's name and doc comment, not part of
///   the contract) are dropped, as rmcp's own `schema_for_input` does;
/// - an argument type with no fields still gets `"properties": {}`, as rmcp's own empty-input
///   schema has it: schemars leaves the key out, and a client may look for it;
/// - the arguments are an object, and unknown fields are ignored, as every TypeScript tool
///   ignores them (the param aliases rely on it), so there's no `additionalProperties: false`;
/// - numbers are `f64`, never an integer type. Accepting `2.5` is the current contract
///   (`z.number()`, and the tools clamp or floor), which an `"integer"` schema would narrow.
///   #293 makes count and limit parameters integers; once it lands, they become `u32` here and
///   this check goes.
pub fn input_schema<T: JsonSchema>() -> Arc<JsonObject> {
    let generator = schemars::generate::SchemaSettings::draft2020_12().into_generator();
    let Value::Object(mut schema) = serde_json::to_value(generator.into_root_schema_for::<T>()).expect("a schema serializes")
    else {
        panic!("a tool's argument type must produce an object schema");
    };
    schema.remove("title");
    schema.remove("description");
    assert_eq!(schema.get("type"), Some(&json!("object")), "a tool's arguments must be an object");
    assert!(!schema.contains_key("additionalProperties"), "a tool's arguments must ignore unknown fields");
    assert!(!mentions_integer(&Value::Object(schema.clone())), "use f64 for numbers until #293: z.number() accepts 2.5");
    schema.entry("properties").or_insert_with(|| json!({}));
    Arc::new(schema)
}

/// Whether any `type` in the schema, at any depth, is or includes `"integer"`.
fn mentions_integer(schema: &Value) -> bool {
    match schema {
        Value::Object(map) => map.iter().any(|(key, value)| {
            (key == "type" && (value == "integer" || value.as_array().is_some_and(|types| types.contains(&json!("integer")))))
                || mentions_integer(value)
        }),
        Value::Array(items) => items.iter().any(mentions_integer),
        _ => false,
    }
}

/// Parse a tool's arguments at the boundary (ADR-0019). As in `parseArgs`: unknown fields are
/// ignored and nothing is coerced (`"5"` is not `5`). `null` means absent because this drops
/// every `null` before serde sees it, so a defaulted non-`Option` field (`#[serde(default)]
/// bool`) takes its default for `null` too. serde alone would reject that `null`: keep the
/// filter in every tool.
///
/// A failure is serde's own. The words a model reads for it are the tool's (`params.rs`), which
/// match the TypeScript server's.
pub fn parse_args<T: DeserializeOwned>(arguments: Option<JsonObject>) -> Result<T, serde_json::Error> {
    let present: JsonObject = arguments.unwrap_or_default().into_iter().filter(|(_, v)| !v.is_null()).collect();
    serde_json::from_value(Value::Object(present))
}

// PARITY(#299): the TypeScript result has no `isError` key, and an absent one differs from `false` on the wire
// — drop if Rust becomes the only server.
/// A result with no `isError` key, as the TypeScript server's has none: an absent `isError` and
/// `isError: false` are different results on the wire (rmcp's own `success` writes the latter).
pub fn success_result(content: Vec<ContentBlock>) -> CallToolResult {
    let mut result = CallToolResult::success(content);
    result.is_error = None;
    result
}

/// A failed call, as `{"error": message}` with `isError`, the TypeScript server's shape.
pub fn error_result(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(json!({ "error": message }).to_string())])
}

/// What the TypeScript server returns for a tool's outcome: the result itself, an ambiguous name as
/// a result with the candidates (not a failure), and anything else `{"error": message}` with
/// `isError`.
pub fn into_result(outcome: Result<CallToolResult, ToolError>) -> CallToolResult {
    match outcome {
        Ok(result) => result,
        Err(ToolError::AmbiguousPage(ambiguous)) => success_result(vec![ContentBlock::text(ambiguous_page_result(&ambiguous))]),
        Err(error) => error_result(&error.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A schema reduced to its meaning, as the parity harness compares `tools/list` (#292):
    /// `$ref`s resolved from `$defs` (the property's own keys win), an optional property's `null`
    /// alternative dropped, `format`, `title` and `$schema` dropped, numbers compared by value, a
    /// missing `required` read as `[]`. Key order never matters to `Value` equality.
    pub(crate) fn meaning(schema: &Value) -> Value {
        let defs = schema.get("$defs").cloned().unwrap_or(json!({}));
        // `required` is a set: its order means nothing, so compare it sorted.
        let mut required: Vec<Value> = schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default();
        required.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        let mut out = normalize(schema, &defs);
        let map = out.as_object_mut().unwrap();
        map.remove("$defs");
        map.insert("required".into(), Value::Array(required.clone()));
        map.entry("properties").or_insert_with(|| json!({}));
        if let Some(Value::Object(properties)) = map.get_mut("properties") {
            for (name, property) in properties.iter_mut() {
                if !required.contains(&json!(name)) {
                    *property = without_null(property.take());
                }
            }
        }
        out
    }

    /// One schema, normalized. Keywords are dropped only here, at schema positions: the keys of
    /// `properties` and `$defs` are names (a parameter may be called `format` or `title`), so
    /// their values are walked as schemas but the keys are kept.
    fn normalize(schema: &Value, defs: &Value) -> Value {
        let Value::Object(map) = schema else { return value_by_meaning(schema) };
        let mut out = JsonObject::new();
        for (key, value) in map {
            let normalized = match key.as_str() {
                "format" | "title" | "$schema" | "$ref" => continue,
                "properties" | "$defs" => Value::Object(
                    value.as_object().unwrap().iter().map(|(name, sub)| (name.clone(), normalize(sub, defs))).collect(),
                ),
                "items" | "not" | "additionalProperties" => normalize(value, defs),
                "anyOf" | "oneOf" | "allOf" => {
                    Value::Array(value.as_array().unwrap().iter().map(|sub| normalize(sub, defs)).collect())
                }
                // Values, not schemas: enum, default, const, required, type, description.
                _ => value_by_meaning(value),
            };
            out.insert(key.clone(), normalized);
        }
        if let Some(Value::String(reference)) = map.get("$ref") {
            let def = &defs[reference.strip_prefix("#/$defs/").unwrap()];
            for (key, value) in normalize(def, defs).as_object().unwrap() {
                out.entry(key.clone()).or_insert(value.clone());
            }
        }
        Value::Object(out)
    }

    /// A JSON value with every number compared by value (`50` and `50.0` are equal).
    fn value_by_meaning(value: &Value) -> Value {
        match value {
            Value::Number(n) => json!(n.as_f64().unwrap()),
            Value::Array(items) => Value::Array(items.iter().map(value_by_meaning).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), value_by_meaning(v))).collect()),
            other => other.clone(),
        }
    }

    /// Optional and nullable mean the same to a caller: drop the `null` alternative.
    fn without_null(property: Value) -> Value {
        let Value::Object(mut map) = property else { return property };
        if let Some(Value::Array(alternatives)) = map.remove("anyOf") {
            let mut rest: Vec<Value> = alternatives.into_iter().filter(|alt| alt != &json!({"type": "null"})).collect();
            if rest.len() == 1 {
                for (key, value) in rest.remove(0).as_object().unwrap() {
                    map.entry(key.clone()).or_insert(value.clone());
                }
            } else {
                map.insert("anyOf".into(), Value::Array(rest));
            }
        }
        if let Some(Value::Array(types)) = map.get("type").cloned() {
            let types: Vec<Value> = types.into_iter().filter(|t| t != "null").collect();
            map.insert("type".into(), if types.len() == 1 { types[0].clone() } else { Value::Array(types) });
        }
        if let Some(Value::Array(values)) = map.get_mut("enum") {
            values.retain(|value| !value.is_null());
        }
        Value::Object(map)
    }

    pub(crate) fn schema_of<T: JsonSchema>() -> Value {
        Value::Object((*input_schema::<T>()).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{meaning, schema_of};
    use super::*;
    use serde::Deserialize;

    /// `format` as the TypeScript tools take it. The doc comment is the type's, not the property's.
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Format {
        Json,
        Markdown,
    }

    fn default_max_nodes() -> f64 {
        50.0
    }

    /// One field of each kind the TypeScript tools take, modelled on the ADR-0016 snapshot
    /// (`logseq_get_page`, `logseq_list_pages`, `logseq_get_concept_network`).
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    struct SampleArgs {
        /// The page to read.
        page_name: String,
        /// Include child blocks
        #[serde(default)]
        include_children: bool,
        /// json (default), or markdown text
        format: Option<Format>,
        /// Most names to return
        limit: Option<f64>,
        /// Maximum pages in the network (default: 50, max: 500)
        #[serde(default = "default_max_nodes")]
        max_nodes: f64,
    }


    /// The TypeScript snapshot's schema for fields of each kind in [`SampleArgs`]
    /// (`logseq_get_page`, `logseq_list_pages`, `logseq_get_concept_network`).
    fn typescript_sample_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "page_name": {"type": "string", "description": "The page to read."},
                "include_children": {"type": "boolean", "default": false, "description": "Include child blocks"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text"},
                "limit": {"type": "number", "description": "Most names to return"},
                "max_nodes": {"type": "number", "default": 50, "description": "Maximum pages in the network (default: 50, max: 500)"},
            },
            "required": ["page_name"],
        })
    }

    #[test]
    fn the_schema_comes_from_the_type_that_parses_the_arguments_and_means_the_typescript_contract() {
        assert_eq!(meaning(&schema_of::<SampleArgs>()), meaning(&typescript_sample_schema()));
    }

    #[test]
    fn required_is_compared_as_a_set() {
        let a = json!({"type": "object", "properties": {}, "required": ["b", "a"]});
        let b = json!({"type": "object", "properties": {}, "required": ["a", "b"]});
        assert_eq!(meaning(&a), meaning(&b));
        assert_ne!(meaning(&a), meaning(&json!({"type": "object", "properties": {}, "required": ["a"]})));
    }

    #[test]
    fn a_parameter_named_like_a_keyword_is_compared_not_dropped() {
        // `format` is a parameter here, not the JSON Schema keyword: it must survive normalizing.
        let ours = meaning(&schema_of::<SampleArgs>());
        assert_eq!(ours["properties"]["format"]["enum"], json!(["json", "markdown"]));
        let mut other_enum = typescript_sample_schema();
        other_enum["properties"]["format"]["enum"] = json!(["json", "html"]);
        assert_ne!(ours, meaning(&other_enum));
        let mut other_description = typescript_sample_schema();
        other_description["properties"]["format"]["description"] = json!("something else");
        assert_ne!(ours, meaning(&other_description));
        let mut no_format = typescript_sample_schema();
        no_format["properties"].as_object_mut().unwrap().remove("format");
        assert_ne!(ours, meaning(&no_format));
    }

    #[test]
    fn the_schema_is_schemars_own_with_no_zod_quirks_copied() {
        let schema = schema_of::<SampleArgs>();
        assert!(schema.get("$defs").is_some_and(|defs| defs.get("Format").is_some()), "{schema}");
        assert_eq!(schema["properties"]["limit"]["type"], json!(["number", "null"]));
        assert!(schema.get("title").is_none() && schema.get("description").is_none());
        assert!(schema.get("additionalProperties").is_none());
    }

    #[derive(Deserialize, JsonSchema)]
    #[allow(dead_code)]
    struct IntegerArgs {
        max_depth: Option<u32>,
    }

    #[test]
    #[should_panic(expected = "use f64 for numbers until #293")]
    fn an_integer_field_is_refused_until_293_lands() {
        input_schema::<IntegerArgs>();
    }

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn parsing_ignores_unknown_fields_treats_null_as_absent_and_never_coerces() {
        let parsed: SampleArgs = parse_args(args(json!({
            "page_name": "my page", "limit": null, "include_children": null, "max_nodes": null, "format": "markdown", "extra": 1
        })))
        .unwrap();
        assert_eq!(
            parsed,
            SampleArgs {
                page_name: "my page".into(),
                include_children: false,
                format: Some(Format::Markdown),
                limit: None,
                max_nodes: 50.0
            }
        );
        // zod's z.number() takes a fraction; the tool clamps or floors it.
        let parsed: SampleArgs = parse_args(args(json!({"page_name": "x", "max_nodes": 2.5}))).unwrap();
        assert_eq!(parsed.max_nodes, 2.5);
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "limit": "5"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "include_children": "true"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": "x", "format": "html"}))).is_err());
        assert!(parse_args::<SampleArgs>(args(json!({"page_name": null}))).unwrap_err().to_string().contains("page_name"));
        assert!(parse_args::<SampleArgs>(None).is_err());
        // Without the null filter serde rejects a null for a defaulted bool: the filter does that work.
        assert!(serde_json::from_value::<SampleArgs>(json!({"page_name": "x", "include_children": null})).is_err());
    }

    #[test]
    fn results_keep_key_order_as_json_stringify_does() {
        // A pulled LogSeq entity is passed through as it came; sorting its keys would break
        // byte-for-byte parity with the TypeScript server (ADR-0025 Decision 2).
        let entity: Value = serde_json::from_str(r#"{"uuid":"u","content":"c","id":1}"#).unwrap();
        assert_eq!(json!({"warnings": [], "block": entity}).to_string(), r#"{"warnings":[],"block":{"uuid":"u","content":"c","id":1}}"#);
        let error = error_result("No \"page\"");
        assert_eq!(serde_json::to_value(&error.content[0]).unwrap()["text"], r#"{"error":"No \"page\""}"#);
    }
}
