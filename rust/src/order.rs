//! The order every list of names is in. One fixed rule, so a result never depends on the host's
//! locale, on ICU, or on the order rows arrived in (#299 wave C1).

use std::cmp::Ordering;

/// Orders names by their lowercase form, character by character in code point order, and then
/// by the name itself in code point order. The second step makes it a total order: two names
/// compare equal only when they are the same string, so a tie never depends on arrival order.
///
/// It is a plain order and not a dictionary one. Every capital letter sorts with its lowercase
/// (`Zoe` after `alice`, `alice` before `Alice`), an accented letter sorts after every unaccented
/// one (`Zoe` before `Ágata`), and ideographs follow their code points, block after block.
/// Each character is lowercased on its own (`char::to_lowercase`), so no context or locale is read.
pub fn by_name(a: &str, b: &str) -> Ordering {
    let lower = |name: &str| name.chars().flat_map(char::to_lowercase).collect::<Vec<char>>();
    lower(a).cmp(&lower(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each name is `Less` than every one after it, and `Equal` to itself.
    fn assert_in_order(sorted: &[&str]) {
        for (i, a) in sorted.iter().enumerate() {
            for (j, b) in sorted.iter().enumerate() {
                assert_eq!(by_name(a, b), i.cmp(&j), "{a:?} against {b:?}");
            }
        }
    }

    #[test]
    fn case_does_not_decide_between_different_names() {
        // "Zoe" is not before "alice" because it is a capital: the lowercase forms are compared first
        assert_in_order(&["alice", "Bob", "carol", "Zoe"]);
    }

    #[test]
    fn the_same_name_in_two_cases_is_ordered_by_the_name_itself() {
        // the lowercase forms are equal, so the name decides, and a capital is before its lowercase
        assert_in_order(&["ALICE", "Alice", "alice", "bob"]);
        assert_eq!(by_name("Alice", "alice"), Ordering::Less);
        assert_eq!(by_name("ALICE", "Alice"), Ordering::Less);
        assert_eq!(by_name("alice", "alice"), Ordering::Equal);
    }

    #[test]
    fn an_accented_letter_sorts_after_every_unaccented_one() {
        // a code point order, so \u{e1} (a with acute) is after z; a dictionary order would put it with a
        assert_in_order(&["alvaro", "zoe", "\u{e1}lvaro"]);
        // the capital accented letter sorts with its lowercase: U+00C1 lowercases to U+00E1
        assert_in_order(&["zoe", "\u{c1}gata", "\u{e1}gata"]);
    }

    #[test]
    fn composed_and_decomposed_spellings_are_different_names_in_a_fixed_order() {
        // "caf\u{e9}" (one code point) and "cafe\u{301}" (e and a combining accent) are not equal
        assert_eq!(by_name("caf\u{e9}", "cafe\u{301}"), Ordering::Greater);
        assert_eq!(by_name("cafe\u{301}", "caf\u{e9}"), Ordering::Less);
    }

    #[test]
    fn han_follows_code_points_across_blocks() {
        // U+3400 (Extension A) is before U+4E00 and U+65E5 (the main block), which are before U+20000
        // (Extension B), the order of the code points and not of radical and stroke
        assert_in_order(&["\u{3400}", "\u{4e00}", "\u{65e5}", "\u{20000}"]);
        assert_eq!(by_name("\u{65e5}", "\u{3400}"), Ordering::Greater);
    }

    #[test]
    fn a_character_above_the_basic_plane_is_after_one_in_it() {
        // UTF-16 units would put U+1F680 (D83D DE80) before U+E000; a code point order does not
        assert_eq!(by_name("\u{1f680}", "\u{e000}"), Ordering::Greater);
    }

    #[test]
    fn a_shorter_name_is_before_a_longer_one_it_begins() {
        assert_in_order(&["", "a", "a b", "ab"]);
    }
}
