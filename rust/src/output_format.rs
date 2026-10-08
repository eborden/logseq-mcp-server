//! The `format` parameter of the tools that can answer in Markdown (#43): `json` (the default) or
//! `markdown`. A tool that takes it renders through `crate::markdown`.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::args::Arguments;
use crate::errors::InvalidParameter;

/// The words `format` takes, in the order the TypeScript schema lists them.
pub const FORMAT_VALUES: &[&str] = &["json", "markdown"];

// `format`, as the input schema lists it. Read through `OutputFormat::read`, which words a bad
// value as the TypeScript server does. No doc comment: it would become a `description` of the enum
// beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
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
}
