//! What every tool shares: the read-only hints, the input schema generated from its argument
//! type, and turning a tool's outcome into its result. A tool's own code is in
//! its directory under `tools/`; its arguments are parsed by `crate::args::parse_args`.

use std::sync::Arc;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, ToolAnnotations};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};

use crate::errors::ToolError;
use crate::meta::ambiguous_page_result;

/// Hints shared by every tool: each only reads from one known local LogSeq (BR-0002).
pub fn read_only_annotations(title: &str) -> ToolAnnotations {
    ToolAnnotations::with_title(title).read_only(true).destructive(false).idempotent(true).open_world(false)
}

/// A tool's `inputSchema`, generated from the type its arguments are parsed into, so the two
/// can't drift apart (ADR-0019). The schema is schemars' own (draft 2020-12, `null` in an
/// `Option`'s type, `format` on numbers). The parity harness compares schemas by meaning (#292), so
/// only the contract matters, not how a schema is spelled:
/// - every named type (an enum such as `format`) is written where it is used, with no `$defs` and
///   no `$ref` (`inline_subschemas`): the MCP SDK's client drops `$defs` from a tool's `inputSchema`
///   (the parity harness reads the list through that client, and so do real clients), so a `$ref`
///   into it would point at nothing there. A type needs no attribute of its own, so none can be
///   forgotten, and the assert below fails on a `$defs` that gets through anyway;
/// - the top-level `title` and `description` (the Rust type's name and doc comment, not part of
///   the contract) are dropped, as rmcp's own `schema_for_input` does;
/// - an argument type with no fields still gets `"properties": {}`, as rmcp's own empty-input
///   schema has it: schemars leaves the key out, and a client may look for it;
/// - the arguments are an object, and unknown fields are ignored, as in every tool
///   (the param aliases rely on it), so there's no `additionalProperties: false`;
/// - a count, limit, offset or depth is an integer (#293): schemars gives an
///   unsigned type `"type": "integer"` and `"minimum": 0`, plus a `format` the comparison drops. A
///   parameter whose minimum is 1 says so with `#[schemars(range(min = 1))]`, and
///   `crate::args::parse_args`, the one parse of a tool's arguments, enforces the schema's minimum.
///   It reads a count up to 2^53 - 1 into a `u64`, and refuses a bad value (`2.5`, `-1`, `"5"`).
pub fn input_schema<T: JsonSchema>() -> Arc<JsonObject> {
    let generator = schemars::generate::SchemaSettings::draft2020_12().with(|settings| settings.inline_subschemas = true).into_generator();
    let Value::Object(mut schema) = serde_json::to_value(generator.into_root_schema_for::<T>()).expect("a schema serializes")
    else {
        panic!("a tool's argument type must produce an object schema");
    };
    schema.remove("title");
    schema.remove("description");
    assert_eq!(schema.get("type"), Some(&json!("object")), "a tool's arguments must be an object");
    assert!(!schema.contains_key("additionalProperties"), "a tool's arguments must ignore unknown fields");
    assert!(!schema.contains_key("$defs"), "a tool's schema must have no $defs, which the MCP SDK's client drops");
    schema.entry("properties").or_insert_with(|| json!({}));
    Arc::new(schema)
}

/// A tool's output struct as the `Value` the renderers and the result writer take. The keys come out
/// in the order the struct declares its fields, which is the result's key order (BR-0013), so
/// a struct writes its fields in that order and a unit test of it pins the order.
pub fn result_value<T: Serialize>(output: &T) -> Value {
    serde_json::to_value(output).expect("a tool's output serializes: its keys are strings and its numbers finite")
}

/// A result with no `isError` key, as the recorded results have none: an absent `isError` and
/// `isError: false` are different results on the wire (rmcp's own `success` writes the latter). Kept
/// because an absent `isError` is valid MCP, and writing `false` would change every success result in
/// `tests/data/parity/` to save two lines.
pub fn success_result(content: Vec<ContentBlock>) -> CallToolResult {
    let mut result = CallToolResult::success(content);
    result.is_error = None;
    result
}

/// A failed call, as `{"error": message}` with `isError`.
pub fn error_result(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(json!({ "error": message }).to_string())])
}

/// What a client gets for a tool's outcome: the result itself, an ambiguous name as
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

    /// The keys of a result object in the order it writes them. A unit test of a tool's output pins this
    /// (BR-0013): `Value` equality ignores order, so it can't.
    pub(crate) fn keys(value: &Value) -> Vec<&str> {
        value.as_object().expect("an object").keys().map(String::as_str).collect()
    }

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

    /// `format` as the tools take it. The doc comment is the type's, not the property's.
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Format {
        Json,
        Markdown,
    }

    fn default_max_nodes() -> f64 {
        50.0
    }

    /// One field of each kind the tools take, modelled on the recorded `tool-list` golden
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


    /// The recorded schema for fields of each kind in [`SampleArgs`]
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
        // a named type is written in place: the MCP SDK's client drops `$defs`, so a `$ref` would dangle
        assert!(schema.get("$defs").is_none() && !schema.to_string().contains("$ref"), "{schema}");
        assert_eq!(schema["properties"]["format"]["enum"], json!(["json", "markdown", null]), "{schema}");
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
    fn a_count_is_an_integer_with_a_minimum() {
        let schema = schema_of::<IntegerArgs>();
        let depth = &schema["properties"]["max_depth"];
        assert_eq!(depth["type"], json!(["integer", "null"]));
        assert_eq!(depth["minimum"], json!(0));
        // `format` is schemars' own and means nothing to a caller: the harness drops it
        assert_eq!(
            meaning(&schema),
            meaning(&json!({"type": "object", "properties": {"max_depth": {"type": "integer", "minimum": 0}}}))
        );
    }

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    fn parse(value: Value) -> Result<SampleArgs, crate::errors::InvalidParameter> {
        crate::args::parse_args::<SampleArgs>(args(value).as_ref())
    }

    #[test]
    fn parsing_ignores_unknown_fields_treats_null_as_absent_and_never_coerces() {
        let parsed = parse(json!({
            "page_name": "my page", "limit": null, "include_children": null, "max_nodes": null, "format": "markdown", "extra": 1
        }))
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
        // A `number` argument takes a fraction; the tool clamps or floors it.
        assert_eq!(parse(json!({"page_name": "x", "max_nodes": 2.5})).unwrap().max_nodes, 2.5);
        assert!(parse(json!({"page_name": "x", "limit": "5"})).is_err());
        assert!(parse(json!({"page_name": "x", "include_children": "true"})).is_err());
        assert!(parse(json!({"page_name": "x", "format": "html"})).is_err());
        assert!(parse(json!({"page_name": null})).unwrap_err().to_string().contains("page_name"));
        assert!(crate::args::parse_args::<SampleArgs>(None).is_err());
        // serde alone rejects a null for a defaulted bool: dropping every null before parsing does that work.
        assert!(serde_json::from_value::<SampleArgs>(json!({"page_name": "x", "include_children": null})).is_err());
    }

    #[test]
    fn results_keep_keys_in_insertion_order() {
        // A pulled LogSeq entity is passed through as it came; sorting its keys would break the order BR-0004
        // and BR-0013 promise, and the recorded results keep it.
        let entity: Value = serde_json::from_str(r#"{"uuid":"u","content":"c","id":1}"#).unwrap();
        assert_eq!(json!({"warnings": [], "block": entity}).to_string(), r#"{"warnings":[],"block":{"uuid":"u","content":"c","id":1}}"#);
        // A key that reads as an integer stays where it came: serde keeps insertion order, no integer-first hoisting
        let numbered: Value = serde_json::from_str(r#"{"b":1,"2":true,"a":{"10":0,"9":0,"x":1},"1":null}"#).unwrap();
        assert_eq!(numbered.to_string(), r#"{"b":1,"2":true,"a":{"10":0,"9":0,"x":1},"1":null}"#);
        let error = error_result("No \"page\"");
        assert_eq!(serde_json::to_value(&error.content[0]).unwrap()["text"], r#"{"error":"No \"page\""}"#);
    }
}
