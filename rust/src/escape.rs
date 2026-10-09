//! Escaping text for a regular expression.

/// Escape every regex metacharacter in `text` so it matches literally: `. * + ? ^ $ { } ( ) | [ ] \`,
/// the set a JavaScript `RegExp` treats as special. LogSeq evaluates `re-pattern` with a JavaScript
/// `RegExp`, so the result is safe to embed in `"(?i)" + escape_regex(text)`.
///
/// This is only the regex layer. When the pattern is sent as a Datalog `:in` input, the client
/// applies the second (EDN string) layer of escaping.
pub fn escape_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_metacharacter_is_escaped_and_other_text_is_left_alone() {
        assert_eq!(escape_regex(r".*+?^${}()|[]\"), r"\.\*\+\?\^\$\{\}\(\)\|\[\]\\");
        assert_eq!(escape_regex("plain text, 100% café #tag -_/"), "plain text, 100% café #tag -_/");
        assert_eq!(escape_regex(""), "");
        assert_eq!(escape_regex("a.b"), r"a\.b");
    }
}
