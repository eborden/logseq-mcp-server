//! Tool arguments at the boundary: the parameter aliases (BR-0008, `src/utils/param-aliases.ts`)
//! and the wording of a bad argument (`src/utils/parse-args.ts`).
//!
//! The arguments are parsed into a typed struct by serde, as the server does for every tool
//! (`parse_args` in `server.rs`). What this module adds is the TypeScript server's text for a
//! failure, which the parity harness compares byte for byte, so a model sees one message
//! whichever server answers.

use serde_json::{Map, Value};

use crate::errors::{InvalidParameter, ToolError};
use crate::js;

/// Alternative names a tool accepts for a canonical parameter: `(canonical, aliases)`. They are
/// not in the input schema, so they cost no tokens in `tools/list`. Best-effort, not a contract:
/// a client that validates against the schema rejects an alias-only call before it gets here.
pub type ParamAliases = &'static [(&'static str, &'static [&'static str])];

/// `resolveParamAliases`: the arguments with every alias folded into its canonical parameter and
/// the alias keys removed. Other arguments pass through untouched. An alias and the canonical
/// name (or two aliases) may both be given if they carry the same value. Different values are
/// ambiguous, and nothing is picked silently: that is an [`InvalidParameter`].
pub fn resolve_param_aliases(aliases: ParamAliases, args: Option<Map<String, Value>>) -> Result<Option<Map<String, Value>>, ToolError> {
    let Some(args) = args else { return Ok(None) };
    // `null` and absent are the same argument
    let present = |key: &str| args.get(key).is_some_and(|value| !value.is_null());
    let mut out = args.clone();
    for (canonical, names) in aliases {
        let mut chosen: Option<&str> = present(canonical).then_some(*canonical);
        for alias in *names {
            out.remove(*alias);
            if !present(alias) {
                continue;
            }
            match chosen {
                None => {
                    chosen = Some(alias);
                    out.insert((*canonical).to_owned(), args[*alias].clone());
                }
                Some(chosen_key) if js::json_stringify(&args[chosen_key]) != js::json_stringify(&args[*alias]) => {
                    let chosen_value = js::json_stringify(&args[chosen_key]);
                    return Err(ToolError::InvalidParameter(InvalidParameter {
                        param: (*alias).to_owned(),
                        value: js::json_stringify(&args[*alias]),
                        expected: format!(
                            "the same value as '{chosen_key}' ({chosen_value}), or only one of them. '{alias}' is an alias of '{canonical}'"
                        ),
                        example: Some(format!("{canonical}: {chosen_value}")),
                    }));
                }
                Some(_) => {}
            }
        }
    }
    Ok(Some(out))
}

/// What `parseArgs` made of a bad required string parameter: `missing` when it is absent or
/// `null`, else the value as JSON, and what was expected (`expectedMessage`, `exampleFor`). The wording
/// (`a string, not a number`, `(required)`) began as zod's and is this server's own readable message now.
/// `args` are the arguments as sent.
pub fn bad_string_param(param: &str, args: Option<&Map<String, Value>>) -> InvalidParameter {
    let sent = args.and_then(|args| args.get(param)).filter(|value| !value.is_null());
    let (value, expected) = match sent {
        None => ("missing".to_owned(), "a string (required)".to_owned()),
        Some(value) => (js::json_stringify(value), format!("a string, not {}", kind_of(value))),
    };
    InvalidParameter { param: param.to_owned(), value, expected, example: Some(format!("{param}: \"...\"")) }
}

/// What a value is, in the words of the `Expected:` line (`kindOf`).
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::String(_) => "a string",
        Value::Null => "a null",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PAGE: ParamAliases = &[("page_name", &["name", "page"])];

    fn args(value: Value) -> Option<Map<String, Value>> {
        value.as_object().cloned()
    }

    fn resolved(value: Value) -> Value {
        Value::Object(resolve_param_aliases(PAGE, args(value)).unwrap().unwrap())
    }

    #[test]
    fn an_alias_is_folded_into_the_canonical_name_and_removed() {
        assert_eq!(resolved(json!({"name": "Alice", "other": 1})), json!({"other": 1, "page_name": "Alice"}));
        assert_eq!(resolved(json!({"page": "Alice"})), json!({"page_name": "Alice"}));
        assert_eq!(resolved(json!({"page_name": null, "page": "Alice"})), json!({"page_name": "Alice"}));
    }

    #[test]
    fn the_canonical_name_stays_and_aliases_with_the_same_value_are_dropped() {
        assert_eq!(resolved(json!({"page_name": "Alice", "name": "Alice", "page": null})), json!({"page_name": "Alice"}));
        assert_eq!(resolved(json!({"name": 5, "page": 5})), json!({"page_name": 5}));
    }

    #[test]
    fn two_names_with_different_values_are_refused_naming_the_later_one() {
        let ToolError::InvalidParameter(error) = resolve_param_aliases(PAGE, args(json!({"page_name": "Alice", "name": "Bob"}))).unwrap_err()
        else {
            panic!("expected an invalid parameter")
        };
        assert_eq!(
            error.to_string(),
            "Invalid parameter 'name': \"Bob\"\n\nExpected: the same value as 'page_name' (\"Alice\"), or only one of them. 'name' is an alias of 'page_name'\nExample: page_name: \"Alice\""
        );
        assert!(resolve_param_aliases(PAGE, args(json!({"name": "A", "page": "B"}))).is_err());
    }

    #[test]
    fn no_arguments_pass_through() {
        assert_eq!(resolve_param_aliases(PAGE, None).unwrap(), None);
    }

    #[test]
    fn a_missing_or_null_parameter_is_missing_and_a_wrong_type_is_shown() {
        assert_eq!(
            bad_string_param("page_name", args(json!({})).as_ref()).to_string(),
            "Invalid parameter 'page_name': missing\n\nExpected: a string (required)\nExample: page_name: \"...\""
        );
        assert_eq!(bad_string_param("page_name", args(json!({"page_name": null})).as_ref()).value, "missing");
        assert_eq!(bad_string_param("page_name", None).value, "missing");
        for (sent, shown, kind) in [
            (json!(42), "42", "a number"),
            (json!(true), "true", "a boolean"),
            (json!(["a"]), "[\"a\"]", "an array"),
            (json!({"b": 1, "1": 2}), "{\"1\":2,\"b\":1}", "an object"),
            (json!(1e21), "1e+21", "a number"),
        ] {
            let error = bad_string_param("page_name", args(json!({ "page_name": sent })).as_ref());
            assert_eq!((error.value.as_str(), error.expected), (shown, format!("a string, not {kind}")));
        }
    }
}
