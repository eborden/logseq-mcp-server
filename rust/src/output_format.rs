//! The `format` parameter of the tools that can answer in Markdown (#43): `json` (the default) or
//! `markdown`. A tool that takes it renders through `crate::markdown`.

use schemars::JsonSchema;
use serde::Deserialize;

// `format`, as the input schema lists it, and as a tool's arguments take it: `Option<OutputFormat>`,
// with no default advertised. A word that is neither is refused by `crate::args::parse_args`. No doc
// comment: it would become a `description` of the enum beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Json,
    Markdown,
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
