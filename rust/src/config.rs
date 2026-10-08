//! The config file, parsed once into a typed [`Config`] (the Rust side of `src/config.ts`).
//!
//! Every failure is a [`ConfigError`] variant, so callers and tests tell them apart by variant,
//! never by message text. No message shows a value from the file or the file's text, since any
//! of them could be the token (ADR-0003). The messages match the TypeScript server's word for word.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The API URL when the file sets none (or a falsy one), as in `src/config.ts`.
pub const DEFAULT_API_URL: &str = "http://127.0.0.1:12315";

/// What a field must be, the `<field> <problem>` tail of a [`ConfigError::Validation`] message.
const AUTH_TOKEN_REQUIRED: &str = "is required";
const NOT_A_STRING: &str = "must be a string";
/// Known divergence from TypeScript: `"timeoutMs": 1e999` is `Infinity` to `JSON.parse`, so TS
/// reports this validation error, but serde_json rejects the number itself ("number out of
/// range"), so it is [`ConfigError::InvalidJson`] here. Neither shows a file value. Mapping it
/// would need the key, which serde_json's error doesn't give.
const TIMEOUT_MS: &str = "must be a positive finite number";
const TIPS: &str = "must be a boolean";

/// Replaces a JSON parser message that quotes the file, as `REDACTED_JSON_DETAIL` does in TypeScript.
pub const REDACTED_JSON_DETAIL: &str = "the file is not valid JSON (an unquoted value, a trailing comma or a byte-order mark?); the parser's message is not shown, as it may quote the authToken";

/// The parsed config. Unknown keys in the file are dropped; the optional fields are `None`
/// when the file leaves them out.
#[derive(Clone, PartialEq)]
pub struct Config {
    pub api_url: String,
    pub auth_token: String,
    /// Per-call timeout in milliseconds; positive and finite when set.
    pub timeout_ms: Option<f64>,
    pub tips: Option<bool>,
}

/// Never prints the token (ADR-0003), so a `{:?}` in a log line is safe.
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("api_url", &self.api_url)
            .field("auth_token", &"<redacted>")
            .field("timeout_ms", &self.timeout_ms)
            .field("tips", &self.tips)
            .finish()
    }
}

/// The config file failed to load.
#[derive(Debug)]
pub enum ConfigError {
    /// The file does not exist.
    FileNotFound { path: PathBuf },
    /// The file is not valid JSON. `detail` never quotes the file.
    InvalidJson { detail: String },
    /// A field (or an environment variable, see `crate::env`) has a missing or wrong value. The message never shows
    /// a config-file value.
    Validation { field: String, problem: String },
    /// Any other read error (permissions, a directory), as it came.
    Io(io::Error),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::FileNotFound { path } => {
                write!(f, "Configuration file not found: {}", path.display())
            }
            ConfigError::InvalidJson { detail } => write!(f, "Invalid JSON in config file: {detail}"),
            ConfigError::Validation { field, problem } => {
                write!(f, "Configuration validation failed: {field} {problem}")
            }
            ConfigError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ConfigError {}

fn invalid(field: &str, problem: &str) -> ConfigError {
    ConfigError::Validation { field: field.to_owned(), problem: problem.to_owned() }
}

/// Load and check the config file at `path`.
pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    let text = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ConfigError::FileNotFound { path: path.to_owned() },
        _ => ConfigError::Io(error),
    })?;
    parse_config(&text)
}

/// Parse the config file's text. The checks run in the order `src/config.ts` reports them,
/// so the first problem found is the same error the TypeScript server gives.
pub fn parse_config(text: &str) -> Result<Config, ConfigError> {
    let raw: Value = serde_json::from_str(text)
        .map_err(|error| ConfigError::InvalidJson { detail: json_error_detail(&error.to_string()) })?;

    // 1. An object with a truthy authToken. Anything else is "authToken is required".
    let object = match &raw {
        Value::Object(map) if map.get("authToken").is_some_and(is_truthy) => map,
        _ => return Err(invalid("authToken", AUTH_TOKEN_REQUIRED)),
    };

    // 2. Each field in turn. Nothing is coerced: "5000" is not a timeout, "false" not a boolean.
    // JSON has no `undefined`, so a present `null` in an optional field is a wrong value, as
    // zod's `.optional()` treats it.
    let api_url = match object.get("apiUrl") {
        Some(Value::String(url)) if !url.is_empty() => url.clone(),
        Some(value) if is_truthy(value) => return Err(invalid("apiUrl", NOT_A_STRING)),
        _ => DEFAULT_API_URL.to_owned(),
    };
    let auth_token = match object.get("authToken") {
        Some(Value::String(token)) => token.clone(),
        _ => return Err(invalid("authToken", NOT_A_STRING)),
    };
    let timeout_ms = match object.get("timeoutMs") {
        None => None,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(ms) if ms > 0.0 && ms.is_finite() => Some(ms),
            _ => return Err(invalid("timeoutMs", TIMEOUT_MS)),
        },
        Some(_) => return Err(invalid("timeoutMs", TIMEOUT_MS)),
    };
    let tips = match object.get("tips") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Err(invalid("tips", TIPS)),
    };

    Ok(Config { api_url, auth_token, timeout_ms, tips })
}

/// JavaScript truthiness, which the TypeScript checks use for `authToken` and `apiUrl`. Keep
/// rejecting a missing or empty `authToken` (a safeguard: an empty token fails every call later
/// with a 401), and an empty `apiUrl` falling back to the default.
// PARITY(#299): only which message a non-string token or URL gets follows JavaScript truthiness: `0`,
// `false` and `null` say "authToken is required", while `1`, `true`, `[]` and `{}` get past it and say
// "not a string" — drop that distinction if Rust becomes the only server.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The parser's reason, unless it quotes the file. serde_json's syntax messages name a line and
/// column, not text, but a message with a double quote in it is replaced all the same, as in
/// TypeScript, so a future parser message can't leak the token.
fn json_error_detail(message: &str) -> String {
    if message.contains('"') { REDACTED_JSON_DETAIL.to_owned() } else { message.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "s3cret-token-value";

    fn validation(text: &str) -> (String, String) {
        match parse_config(text) {
            Err(ConfigError::Validation { field, problem }) => (field, problem),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn parses_every_field_and_drops_unknown_keys() {
        let config = parse_config(&format!(
            r#"{{"apiUrl":"http://127.0.0.1:4000","authToken":"{TOKEN}","timeoutMs":1500.5,"tips":false,"extra":1}}"#
        ))
        .unwrap();
        assert_eq!(
            config,
            Config {
                api_url: "http://127.0.0.1:4000".into(),
                auth_token: TOKEN.into(),
                timeout_ms: Some(1500.5),
                tips: Some(false),
            }
        );
    }

    #[test]
    fn a_missing_or_falsy_api_url_is_the_default() {
        for api_url in [None, Some(r#""""#), Some("null"), Some("0"), Some("false")] {
            let field = api_url.map(|v| format!(r#","apiUrl":{v}"#)).unwrap_or_default();
            let config = parse_config(&format!(r#"{{"authToken":"x"{field}}}"#)).unwrap();
            assert_eq!(config.api_url, DEFAULT_API_URL, "apiUrl {api_url:?}");
            assert_eq!((config.timeout_ms, config.tips), (None, None));
        }
    }

    #[test]
    fn auth_token_is_required_before_anything_else() {
        for text in [
            r#"{}"#,
            r#"{"authToken":""}"#,
            r#"{"authToken":null}"#,
            r#"{"authToken":0}"#,
            r#"{"authToken":false}"#,
            r#"[]"#,
            r#"42"#,
            r#"{"apiUrl":7,"timeoutMs":-1}"#,
        ] {
            assert_eq!(validation(text), ("authToken".into(), AUTH_TOKEN_REQUIRED.into()), "{text}");
        }
    }

    #[test]
    fn reports_the_first_wrong_field_in_order() {
        assert_eq!(validation(r#"{"authToken":"x","apiUrl":7,"tips":"no"}"#), ("apiUrl".into(), NOT_A_STRING.into()));
        assert_eq!(validation(r#"{"authToken":true}"#), ("authToken".into(), NOT_A_STRING.into()));
        assert_eq!(validation(r#"{"authToken":"x","tips":"false"}"#), ("tips".into(), TIPS.into()));
        assert_eq!(validation(r#"{"authToken":"x","tips":null}"#), ("tips".into(), TIPS.into()));
        for timeout in ["0", "-5", r#""5000""#, "null", "true"] {
            assert_eq!(
                validation(&format!(r#"{{"authToken":"x","timeoutMs":{timeout}}}"#)),
                ("timeoutMs".into(), TIMEOUT_MS.into()),
                "timeoutMs {timeout}"
            );
        }
    }

    #[test]
    fn validation_messages_never_show_a_file_value() {
        let text = format!(r#"{{"authToken":"{TOKEN}","apiUrl":["{TOKEN}"],"timeoutMs":"{TOKEN}"}}"#);
        let error = parse_config(&text).unwrap_err();
        assert_eq!(error.to_string(), "Configuration validation failed: apiUrl must be a string");
        let text = format!(r#"{{"authToken":"x","timeoutMs":"{TOKEN}"}}"#);
        assert!(!parse_config(&text).unwrap_err().to_string().contains(TOKEN));
    }

    #[test]
    fn invalid_json_never_echoes_the_file() {
        for text in [
            format!(r#"{{"authToken": {TOKEN}}}"#),
            format!(r#"{{"authToken": "{TOKEN}",}}"#),
            format!(r#"{{"authToken": "{TOKEN}"#),
            format!("\u{feff}{{\"authToken\": \"{TOKEN}\"}}"),
            format!(r#"{{"authToken": "{TOKEN}"}} {TOKEN}"#),
        ] {
            match parse_config(&text) {
                Err(error @ ConfigError::InvalidJson { .. }) => {
                    let message = error.to_string();
                    assert!(message.starts_with("Invalid JSON in config file: "), "{message}");
                    assert!(!message.contains(TOKEN), "{message}");
                    assert!(!message.contains("authToken"), "{message}");
                }
                other => panic!("expected InvalidJson for {text:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_infinite_timeout_is_invalid_json_not_a_validation_error() {
        // Pins the divergence documented on TIMEOUT_MS: TypeScript gives
        // ConfigValidationError(timeoutMs) for this file.
        match parse_config(r#"{"authToken":"x","timeoutMs":1e999}"#) {
            Err(ConfigError::InvalidJson { detail }) => assert!(detail.starts_with("number out of range"), "{detail}"),
            other => panic!("expected InvalidJson, got {other:?}"),
        }
    }

    #[test]
    fn a_parser_message_with_a_quote_is_replaced() {
        assert_eq!(json_error_detail(r#"unexpected "abc""#), REDACTED_JSON_DETAIL);
        assert_eq!(
            json_error_detail("EOF while parsing a string at line 1 column 9"),
            "EOF while parsing a string at line 1 column 9"
        );
    }

    #[test]
    fn debug_output_redacts_the_token() {
        let config = parse_config(&format!(r#"{{"authToken":"{TOKEN}"}}"#)).unwrap();
        let debug = format!("{config:?}");
        assert!(!debug.contains(TOKEN), "{debug}");
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn a_missing_file_is_file_not_found() {
        let path = std::env::temp_dir()
            .join(format!("logseq-mcp-config-test-{}", std::process::id()))
            .join("absent.json");
        match load_config(&path) {
            Err(ConfigError::FileNotFound { path: p }) => assert_eq!(p, path),
            other => panic!("expected FileNotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_file_with_bad_json_is_read_and_redacted() {
        let path = std::env::temp_dir().join(format!("logseq-mcp-config-test-{}.json", std::process::id()));
        std::fs::write(&path, format!(r#"{{"authToken": {TOKEN}}}"#)).unwrap();
        let result = load_config(&path);
        std::fs::remove_file(&path).unwrap();
        match result {
            Err(error @ ConfigError::InvalidJson { .. }) => assert!(!error.to_string().contains(TOKEN)),
            other => panic!("expected InvalidJson, got {other:?}"),
        }
    }
}
