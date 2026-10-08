//! What a date-range result suggests next (`logseq_query_by_date_range` in `src/utils/tips.ts`):
//! follow the top concept of the period. Nothing when the result has none (no blocks, or
//! `top_concepts_limit` 0).

use serde_json::json;

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// Tips for a finished result, from the name of the first entry of `summary.topConcepts`.
pub fn date_range_tips(top_concept: Option<&str>) -> Vec<String> {
    let mut tips = Vec::new();
    if let Some(name) = top_concept.and_then(non_empty) {
        tips.push(format!("To follow the top concept: {}.", suggest_call("logseq_build_context", &json!({"topic_name": name}))));
    }
    tips.truncate(MAX_TIPS);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_top_concept_is_the_tip() {
        assert_eq!(date_range_tips(Some("Project Atlas")), [r#"To follow the top concept: logseq_build_context {"topic_name":"Project Atlas"}."#]);
        // a name with quotes stays a valid call
        assert_eq!(
            date_range_tips(Some("say \"hi\"")),
            [r#"To follow the top concept: logseq_build_context {"topic_name":"say \"hi\""}."#]
        );
    }

    #[test]
    fn no_top_concept_or_a_blank_one_is_no_tip() {
        assert!(date_range_tips(None).is_empty());
        assert!(date_range_tips(Some("  ")).is_empty());
    }
}
