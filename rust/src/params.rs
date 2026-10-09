//! Tool arguments at the boundary: the parameter aliases (BR-0008). A tool folds them in first, and
//! then parses what is left into its `Args` type with `crate::args::parse_args`.

use serde_json::{Map, Value};

use crate::errors::{InvalidParameter, ToolError};

/// Alternative names a tool accepts for a canonical parameter: `(canonical, aliases)`. They are
/// not in the input schema, so they cost no tokens in `tools/list`. Best-effort, not a contract:
/// a client that validates against the schema rejects an alias-only call before it gets here.
pub type ParamAliases = &'static [(&'static str, &'static [&'static str])];

/// The arguments with every alias folded into its canonical parameter and
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
                Some(chosen_key) if !same_value(&args[chosen_key], &args[*alias]) => {
                    let chosen_value = args[chosen_key].to_string();
                    return Err(ToolError::InvalidParameter(InvalidParameter {
                        param: (*alias).to_owned(),
                        value: args[*alias].to_string(),
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

/// Whether two arguments carry the same value. Numbers compare by value, since a JSON client
/// may write one number either way (`1` and `1.0` are one number; serde_json's own `==` tells them apart), and an object's keys
/// may come in any order.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| same_value(a, b)))
        }
        _ => a == b,
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
    fn numbers_are_the_same_when_their_values_are() {
        // `1` and `1.0` are one number to a JSON client, which serde_json's `==` calls two
        let sent: Value = serde_json::from_str(r#"{"name": 1, "page": 1.0}"#).unwrap();
        assert_eq!(resolved(sent).get("page_name"), Some(&json!(1)));
        let nested: Value = serde_json::from_str(r#"{"name": [1, {"a": 2}], "page": [1.0, {"a": 2.0}]}"#).unwrap();
        assert!(resolve_param_aliases(PAGE, args(nested)).is_ok());
        assert!(resolve_param_aliases(PAGE, args(json!({"name": 1, "page": 1.5}))).is_err());
        assert!(resolve_param_aliases(PAGE, args(json!({"name": "1", "page": 1}))).is_err());
        assert!(resolve_param_aliases(PAGE, args(json!({"name": [1, 2], "page": [1]}))).is_err());
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
}
