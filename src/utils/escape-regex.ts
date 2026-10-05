/**
 * Escape every regex metacharacter in a string so it matches literally.
 *
 * Covers `. * + ? ^ $ { } ( ) | [ ] \`, the set JavaScript's RegExp treats as
 * special. LogSeq evaluates `re-pattern` with a JavaScript RegExp, so the
 * result is safe to embed in a pattern such as `"(?i)" + escapeRegex(text)`.
 *
 * This is only the regex layer. When the pattern is sent to LogSeq as a
 * Datalog `:in` input, `LogseqClient.executeDatalogQuery` applies the second
 * (EDN string) layer of escaping.
 *
 * @param text - Literal text to match
 * @returns Text with all regex metacharacters backslash-escaped
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
