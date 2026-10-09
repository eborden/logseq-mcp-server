//! The `format` parameter of the tools that can answer in Markdown (#43): `json` (the default) or
//! `markdown`. A tool that takes it renders through `crate::markdown`. The flat-list tools take
//! [`ListFormat`] instead: `json` (the default) or `toon`, written through `crate::toon` (BR-0014).

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::errors::ToolError;
use crate::toon;

// `format`, as the input schema lists it, and as a tool's arguments take it: `Option<OutputFormat>`,
// with no default advertised. A word that is neither is refused by `crate::args::parse_args`. No doc
// comment: it would become a `description` of the enum beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Json,
    Markdown,
}

// `format` of a flat-list tool, as the input schema lists it: `Option<ListFormat>`, with no default
// advertised. Its own type, not a third value of `OutputFormat`, so a tool that renders Markdown does not
// advertise a word it can't write. No doc comment, as above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ListFormat {
    Json,
    Toon,
}

impl ListFormat {
    /// The text of one content block of a result: the value as JSON (the bytes every tool wrote before
    /// this parameter existed) unless TOON was asked for. Every block of a result goes through here, so
    /// the meta and tips blocks are in the same format as the data.
    pub fn text(format: Option<ListFormat>, value: &Value) -> Result<String, ToolError> {
        match format {
            Some(ListFormat::Toon) => toon::encode(value),
            Some(ListFormat::Json) | None => Ok(value.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::testing::{Takes, parse, sweep};
    use serde_json::json;

    #[derive(Debug, Deserialize, JsonSchema)]
    struct WithFormat {
        format: Option<OutputFormat>,
    }

    #[test]
    fn format_is_absent_json_or_markdown_by_name() {
        assert_eq!(parse::<WithFormat>(json!({})).unwrap().format, None);
        assert_eq!(parse::<WithFormat>(json!({"format": null})).unwrap().format, None);
        assert_eq!(parse::<WithFormat>(json!({"format": "json"})).unwrap().format, Some(OutputFormat::Json));
        assert_eq!(parse::<WithFormat>(json!({"format": "markdown"})).unwrap().format, Some(OutputFormat::Markdown));
        assert!(parse::<WithFormat>(json!({"format": "xml"})).is_err());
        sweep::<WithFormat>(json!({}), "format", Takes::Words(&["json", "markdown"]), false);
    }
}
