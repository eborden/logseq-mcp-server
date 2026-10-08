//! The `format` parameter of the tools that can answer in Markdown (#43): `json` (the default) or
//! `markdown`. The Rust server writes only JSON so far; the Markdown renderer is a later task
//! (#310), and until it lands a call that asks for it is told so, before any LogSeq call is made.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::args::Arguments;
use crate::errors::{InvalidParameter, ToolError};

/// The words `format` takes, in the order the TypeScript schema lists them.
pub const FORMAT_VALUES: &[&str] = &["json", "markdown"];

// `format`, as the input schema lists it. Read through `OutputFormat::read`, which words a bad
// value as the TypeScript server does. It is inlined into each tool's schema, not referenced from
// `$defs`: the MCP SDK's client drops `$defs` from a tool's `inputSchema`, so a `$ref` into it
// points at nothing there (the parity harness reads the list through that client). No doc comment
// either, which would become a `description` of the enum beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum OutputFormat {
    Json,
    Markdown,
}

impl OutputFormat {
    /// `format` as sent, `None` when it is absent or `null` (`formatArg`: no default is advertised).
    pub fn read(args: &Arguments<'_>) -> Result<Option<OutputFormat>, InvalidParameter> {
        Ok(args
            .optional_enum("format", FORMAT_VALUES)?
            .map(|word| if word == "markdown" { OutputFormat::Markdown } else { OutputFormat::Json }))
    }
}

/// Fails for `markdown`, which this server doesn't write yet. An absent `format` is `json`.
pub fn require_json(format: Option<OutputFormat>) -> Result<(), ToolError> {
    match format {
        Some(OutputFormat::Markdown) => Err(ToolError::Failed(
            "format \"markdown\" is not available in the Rust server yet (#310). Use format \"json\", or leave format out.".to_owned(),
        )),
        Some(OutputFormat::Json) | None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(value: serde_json::Value) -> Result<Option<OutputFormat>, InvalidParameter> {
        let args = value.as_object().cloned().unwrap();
        OutputFormat::read(&Arguments::new(Some(&args)))
    }

    #[test]
    fn format_is_absent_json_or_markdown_by_name() {
        assert_eq!(read(json!({})).unwrap(), None);
        assert_eq!(read(json!({"format": null})).unwrap(), None);
        assert_eq!(read(json!({"format": "json"})).unwrap(), Some(OutputFormat::Json));
        assert_eq!(read(json!({"format": "markdown"})).unwrap(), Some(OutputFormat::Markdown));
        assert!(read(json!({"format": "xml"})).is_err());
    }

    #[test]
    fn markdown_is_refused_for_now_and_json_passes() {
        assert!(require_json(None).is_ok());
        assert!(require_json(Some(OutputFormat::Json)).is_ok());
        let error = require_json(Some(OutputFormat::Markdown)).unwrap_err();
        assert!(error.to_string().contains("#310"), "{error}");
    }
}
