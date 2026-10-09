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
/// The largest `timeoutMs` the file may set: `i32::MAX` ms, about 24.8 days, the longest timer
/// the JavaScript runtimes take. Anything longer is no timeout in practice, so it is refused at
/// load (ADR-0019) and no call has to check it again.
pub const MAX_TIMEOUT_MS: u64 = 2_147_483_647;
/// A `timeoutMs` that is no whole number of milliseconds of at least 1: a string, `null`, a
/// fraction, zero or a negative number.
const TIMEOUT_MS: &str = "must be a whole number of milliseconds, at least 1";
/// A whole `timeoutMs` above [`MAX_TIMEOUT_MS`]. The limit in the text is the constant, not a file value.
const TIMEOUT_MS_TOO_LARGE: &str = "must be at most 2147483647 milliseconds (about 24.8 days)";
// `"timeoutMs": 1e999` never reaches these checks: serde_json rejects the number itself
// ("number out of range"), so the file is `ConfigError::InvalidJson`, which shows no file value.
const TIPS: &str = "must be a boolean";

/// Replaces a JSON parser message that quotes the file, as `REDACTED_JSON_DETAIL` does in TypeScript.
pub const REDACTED_JSON_DETAIL: &str = "the file is not valid JSON (an unquoted value, a trailing comma or a byte-order mark?); the parser's message is not shown, as it may quote the authToken";

/// The parsed config. Unknown keys in the file are dropped; the optional fields are `None`
/// when the file leaves them out.
#[derive(Clone, PartialEq)]
pub struct Config {
    pub api_url: String,
    pub auth_token: String,
    /// Per-call timeout in whole milliseconds, from 1 to [`MAX_TIMEOUT_MS`], when set.
    pub timeout_ms: Option<u64>,
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

    // 1. An object with an authToken that is present, not `null` and not empty. Anything else is
    // "authToken is required" (an empty token would fail every call later with a 401). A token of
    // the wrong type is reported in step 2, after the fields before it.
    let object = match &raw {
        Value::Object(map) if !matches!(map.get("authToken"), None | Some(Value::Null)) && map.get("authToken").and_then(Value::as_str) != Some("") => map,
        _ => return Err(invalid("authToken", AUTH_TOKEN_REQUIRED)),
    };

    // 2. Each field in turn. Nothing is coerced: "5000" is not a timeout, "false" not a boolean.
    // JSON has no `undefined`, so a present `null` in an optional field is a wrong value, as
    // zod's `.optional()` treats it. An `apiUrl` that is absent, `null` or empty is the default.
    let api_url = match object.get("apiUrl") {
        None | Some(Value::Null) => DEFAULT_API_URL.to_owned(),
        Some(Value::String(url)) if url.is_empty() => DEFAULT_API_URL.to_owned(),
        Some(Value::String(url)) => url.clone(),
        Some(_) => return Err(invalid("apiUrl", NOT_A_STRING)),
    };
    let auth_token = match object.get("authToken") {
        Some(Value::String(token)) => token.clone(),
        _ => return Err(invalid("authToken", NOT_A_STRING)),
    };
    let timeout_ms = match object.get("timeoutMs") {
        None => None,
        Some(Value::Number(n)) => Some(timeout_ms(n).map_err(|problem| invalid("timeoutMs", problem))?),
        Some(_) => return Err(invalid("timeoutMs", TIMEOUT_MS)),
    };
    let tips = match object.get("tips") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Err(invalid("tips", TIPS)),
    };

    Ok(Config { api_url, auth_token, timeout_ms, tips })
}

/// A `timeoutMs` number as whole milliseconds. JSON has one number type, so `5000.0` and `5e3`
/// are whole numbers like `5000`; a fraction is not. The problem names the rule, never the value.
fn timeout_ms(n: &serde_json::Number) -> Result<u64, &'static str> {
    let ms = match n.as_u64() {
        Some(ms) => ms,
        // Not a non-negative integer literal: a float (whole or not) or a negative number.
        // A float past u64's range saturates in `as`, which is still above the maximum.
        None => n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 1.0).ok_or(TIMEOUT_MS)? as u64,
    };
    match ms {
        0 => Err(TIMEOUT_MS),
        1..=MAX_TIMEOUT_MS => Ok(ms),
        _ => Err(TIMEOUT_MS_TOO_LARGE),
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
            r#"{{"apiUrl":"http://127.0.0.1:4000","authToken":"{TOKEN}","timeoutMs":1500,"tips":false,"extra":1}}"#
        ))
        .unwrap();
        assert_eq!(
            config,
            Config {
                api_url: "http://127.0.0.1:4000".into(),
                auth_token: TOKEN.into(),
                timeout_ms: Some(1500),
                tips: Some(false),
            }
        );
    }

    #[test]
    fn a_missing_null_or_empty_api_url_is_the_default() {
        for api_url in [None, Some(r#""""#), Some("null")] {
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
        // a token or URL of the wrong type is "not a string", whatever its value (`0` and `false` too)
        for wrong in ["true", "false", "0", "1", "[]", "{}"] {
            assert_eq!(validation(&format!(r#"{{"authToken":{wrong}}}"#)), ("authToken".into(), NOT_A_STRING.into()), "{wrong}");
            assert_eq!(validation(&format!(r#"{{"authToken":"x","apiUrl":{wrong}}}"#)), ("apiUrl".into(), NOT_A_STRING.into()), "{wrong}");
        }
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

    fn timeout_of(timeout: &str) -> Result<Option<u64>, (String, String)> {
        match parse_config(&format!(r#"{{"authToken":"x","timeoutMs":{timeout}}}"#)) {
            Ok(config) => Ok(config.timeout_ms),
            Err(ConfigError::Validation { field, problem }) => Err((field, problem)),
            other => panic!("timeoutMs {timeout}: expected a config or a validation error, got {other:?}"),
        }
    }

    fn timeout_error(problem: &str) -> Result<Option<u64>, (String, String)> {
        Err(("timeoutMs".into(), problem.into()))
    }

    #[test]
    fn the_timeout_is_checked_at_its_bounds_when_the_config_loads() {
        // The smallest and the largest accepted value, and the first one past each end.
        assert_eq!(timeout_of("1"), Ok(Some(1)));
        assert_eq!(timeout_of("0"), timeout_error(TIMEOUT_MS));
        assert_eq!(timeout_of("2147483647"), Ok(Some(MAX_TIMEOUT_MS)));
        assert_eq!(timeout_of("2147483648"), timeout_error(TIMEOUT_MS_TOO_LARGE));
        assert_eq!(MAX_TIMEOUT_MS, i32::MAX as u64);
        assert!(TIMEOUT_MS_TOO_LARGE.contains(&(MAX_TIMEOUT_MS).to_string()));
        // Far past it: past u64 (a float or a big integer literal), and an exact u64::MAX.
        for too_large in ["18446744073709551615", "18446744073709551616", "1e300", "2147483648.0"] {
            assert_eq!(timeout_of(too_large), timeout_error(TIMEOUT_MS_TOO_LARGE), "timeoutMs {too_large}");
        }
    }

    #[test]
    fn a_timeout_that_is_no_whole_number_is_refused_at_load() {
        for fraction in ["1500.5", "0.5", "0.999", "2147483646.5", "-1500.5", "1e-3"] {
            assert_eq!(timeout_of(fraction), timeout_error(TIMEOUT_MS), "timeoutMs {fraction}");
        }
        // JSON has one number type, so a whole number written as a float is the same number.
        for (written, ms) in [("5000.0", 5000), ("5e3", 5000), ("1.0", 1), ("2147483647.0", 2147483647)] {
            assert_eq!(timeout_of(written), Ok(Some(ms)), "timeoutMs {written}");
        }
        for not_positive in ["-1", "-0", "-0.0", "0.0", "-9223372036854775808", "-1e300"] {
            assert_eq!(timeout_of(not_positive), timeout_error(TIMEOUT_MS), "timeoutMs {not_positive}");
        }
        assert_eq!(timeout_of("null"), timeout_error(TIMEOUT_MS));
        assert_eq!(parse_config(r#"{"authToken":"x"}"#).unwrap().timeout_ms, None);
    }

    #[test]
    fn the_timeout_error_never_shows_the_value() {
        // Each message is the same fixed text whatever the file held (ADR-0003).
        for (value, rule) in [
            ("1500.5", "must be a whole number of milliseconds, at least 1"),
            ("-7777", "must be a whole number of milliseconds, at least 1"),
            ("2147483649", "must be at most 2147483647 milliseconds (about 24.8 days)"),
            ("123456789012345678901234567890", "must be at most 2147483647 milliseconds (about 24.8 days)"),
        ] {
            let text = format!(r#"{{"authToken":"x","timeoutMs":{value}}}"#);
            assert_eq!(
                parse_config(&text).unwrap_err().to_string(),
                format!("Configuration validation failed: timeoutMs {rule}"),
                "timeoutMs {value}"
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
        // serde_json rejects the number itself, so no timeoutMs check sees it (see MAX_TIMEOUT_MS).
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
