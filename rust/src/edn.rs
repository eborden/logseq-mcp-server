//! Values that go into a Datalog query: the inputs bound to its `:in` variables (ADR-0013), and
//! the few literals still embedded in its text (`ground` vectors of entity ids and `#uuid`s).
//!
//! Each value's type says what it means, and only a valid one can be built, so the checks the
//! TypeScript builders make at run time (`toLowerCase()` before every `:block/name` lookup,
//! `groundIds`' `Number.isInteger`, `groundUuids`' pattern) happen once, where the value is
//! parsed, and a query builder can't skip them:
//! - [`PageName`] is lowercased when it is made (constraint 5), so a `:block/name` lookup can't
//!   be sent mixed case. There is no way to get one from a `String` without lowercasing it.
//! - [`JournalDay`] is a real calendar date, written as LogSeq's `YYYYMMDD` integer.
//! - [`PageId`] is a positive `:db/id`; [`BlockUuid`] is a strict 8-4-4-4-12 hex uuid, lowercase.
//!
//! LogSeq reads every input after the query string as EDN, so a bare string is read as a symbol
//! and matches nothing. Each input is sent as its JSON text: a JSON string literal is a valid EDN
//! string literal, a JSON array of strings a valid EDN vector, and quotes, backslashes and control
//! characters come out escaped. The text is byte for byte what `JSON.stringify` gives for the same
//! value in `src/client.ts`, which the parity harness (#124) compares.
//!
//! [`DatalogInput`] has no `From<String>` or `From<i64>`: which variant a value is must be written
//! out, so a page name can't slip through as free text by `.into()`. There is no list of plain
//! strings either: the only list input the TypeScript builders bind is a list of page names.

use std::fmt;

use serde_json::Value;

/// One `:in` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatalogInput {
    /// Free text: a search term, a regex source for `re-pattern`, a property value. Sent as is.
    Str(String),
    /// A page name for a `:block/name` lookup. Lowercase by construction.
    PageName(PageName),
    /// Page names for `:in $ [?n ...]`.
    PageNames(Vec<PageName>),
    /// A journal day for `:block/journal-day`.
    JournalDay(JournalDay),
    /// `/` and a page name, for `clojure.string/ends-with?` on `:block/name`: the namespace
    /// leaf lookup (`namespaceLeafPages`). Lowercase by construction, as the name is.
    LeafSuffix(PageName),
}

impl DatalogInput {
    /// The EDN text LogSeq receives for this input.
    pub fn to_edn(&self) -> String {
        let value = match self {
            DatalogInput::Str(s) => Value::from(s.as_str()),
            DatalogInput::PageName(name) => Value::from(name.as_str()),
            DatalogInput::PageNames(names) => Value::from(names.iter().map(PageName::as_str).collect::<Vec<_>>()),
            DatalogInput::JournalDay(day) => Value::from(day.as_int()),
            DatalogInput::LeafSuffix(name) => Value::from(format!("/{}", name.as_str())),
        };
        // Serializing a Value made of strings and integers can't fail.
        serde_json::to_string(&value).expect("a string, integer or string list serializes")
    }
}

/// A value that failed to parse into one of this module's types. The message names the value:
/// each is a tool argument or a value from LogSeq, never a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidValue {
    JournalDay(String),
    PageId(i64),
    BlockUuid(String),
}

impl fmt::Display for InvalidValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidValue::JournalDay(value) => {
                write!(f, "Invalid journal day: {value} (expected a calendar date as YYYYMMDD)")
            }
            InvalidValue::PageId(value) => write!(f, "Invalid entity id: {value} (expected a positive integer)"),
            InvalidValue::BlockUuid(value) => {
                let shown = serde_json::to_string(value).expect("a string serializes");
                write!(f, "Invalid block uuid: {shown} (expected 8-4-4-4-12 hex digits)")
            }
        }
    }
}

impl std::error::Error for InvalidValue {}

/// A page name as `:block/name` stores it: lowercase. The original case is gone once this is
/// made; keep the caller's string for `originalName` in results.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PageName(String);

impl PageName {
    /// Lowercases `name` as `toLowerCase()` does (Unicode default case conversion). Any string
    /// is a name LogSeq can be asked about, so this can't fail.
    pub fn new(name: &str) -> Self {
        PageName(name.to_lowercase())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A calendar date as LogSeq's `:block/journal-day` holds it: the integer `YYYYMMDD`, always
/// eight digits (`10000101..=99991231`, so year 1000 to 9999). Only a real date can be built
/// (month 1-12, the month's day count, leap years).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JournalDay(u32);

/// What [`JournalDay::parse`] accepts: an integer (`20250101`) or exactly eight ASCII digits
/// (`"20250101"`). Either way the value must have eight digits, so `10101` is not year 1 and
/// `"00010101"` isn't either. A negative number, a timestamp or any other text has no digits.
pub trait JournalDayDigits {
    fn digits(self) -> Option<u32>;
}

impl JournalDayDigits for u32 {
    fn digits(self) -> Option<u32> {
        Some(self)
    }
}

impl JournalDayDigits for i64 {
    fn digits(self) -> Option<u32> {
        u32::try_from(self).ok()
    }
}

impl JournalDayDigits for &str {
    fn digits(self) -> Option<u32> {
        (self.len() == 8 && self.bytes().all(|b| b.is_ascii_digit())).then(|| self.parse().ok()).flatten()
    }
}

impl JournalDay {
    pub fn from_ymd(year: u32, month: u32, day: u32) -> Result<Self, InvalidValue> {
        let valid = (1000..=9999).contains(&year) && (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day);
        if valid {
            Ok(JournalDay(year * 10000 + month * 100 + day))
        } else {
            Err(InvalidValue::JournalDay(format!("{year:04}{month:02}{day:02}")))
        }
    }

    /// Parse `YYYYMMDD` from an integer or an eight-digit string.
    pub fn parse<D: JournalDayDigits + fmt::Display + Copy>(value: D) -> Result<Self, InvalidValue> {
        let digits = value
            .digits()
            .filter(|digits| (10000101..=99991231).contains(digits))
            .ok_or_else(|| InvalidValue::JournalDay(value.to_string()))?;
        JournalDay::from_ymd(digits / 10000, digits / 100 % 100, digits % 100)
            .map_err(|_| InvalidValue::JournalDay(value.to_string()))
    }

    /// The `YYYYMMDD` integer, as LogSeq stores it.
    pub fn as_int(self) -> u32 {
        self.0
    }

    pub fn ymd(self) -> (u32, u32, u32) {
        (self.0 / 10000, self.0 / 100 % 100, self.0 % 100)
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// An entity's `:db/id`, here a page's. DataScript ids are positive, so zero and negatives are
/// refused. Embedded in query text through [`ground_ids`], never bound with `:in`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PageId(u64);

impl PageId {
    pub fn new(id: i64) -> Result<Self, InvalidValue> {
        u64::try_from(id).ok().filter(|&id| id > 0).map(PageId).ok_or(InvalidValue::PageId(id))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

/// A block uuid: 8-4-4-4-12 hex digits, any case on input, lowercase once parsed (as
/// `groundUuids` writes it). The pattern leaves out quotes, brackets and whitespace, so an
/// embedded `#uuid "..."` literal can't be ended early. A string that isn't one can't become one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BlockUuid(String);

impl BlockUuid {
    pub fn parse(value: &str) -> Result<Self, InvalidValue> {
        let bytes = value.as_bytes();
        let valid = bytes.len() == 36
            && bytes.iter().enumerate().all(|(i, &b)| match i {
                8 | 13 | 18 | 23 => b == b'-',
                _ => b.is_ascii_hexdigit(),
            });
        if valid { Ok(BlockUuid(value.to_ascii_lowercase())) } else { Err(InvalidValue::BlockUuid(value.to_owned())) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A `ground` clause binding each id to `variable`, as `DatalogQueryBuilder.groundIds` writes it:
/// `[(ground [1 2 3]) [?p ...]]`. Bind it straight to the entity variable (CLAUDE.md
/// constraint 6). `variable` is part of the query, not input, so it must be a `?name`.
pub fn ground_ids(ids: &[PageId], variable: &str) -> String {
    assert_logic_variable(variable);
    let ids: Vec<String> = ids.iter().map(|id| id.get().to_string()).collect();
    format!("[(ground [{}]) [{variable} ...]]", ids.join(" "))
}

/// A `ground` clause of `#uuid` literals, as `DatalogQueryBuilder.groundUuids` writes it:
/// `[(ground [#uuid "…" #uuid "…"]) [?u ...]]`. `:block/uuid` holds uuid values, so a string
/// never matches (constraint 7); the literal is what does.
pub fn ground_uuids(uuids: &[BlockUuid], variable: &str) -> String {
    assert_logic_variable(variable);
    let literals: Vec<String> = uuids.iter().map(|uuid| format!("#uuid \"{}\"", uuid.as_str())).collect();
    format!("[(ground [{}]) [{variable} ...]]", literals.join(" "))
}

fn assert_logic_variable(variable: &str) {
    let valid = variable.len() > 1
        && variable.starts_with('?')
        && variable[1..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    assert!(valid, "a Datalog variable is written in the query: {variable:?}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> String {
        DatalogInput::Str(value.to_owned()).to_edn()
    }

    #[test]
    fn a_string_is_quoted_so_it_is_not_read_as_a_symbol() {
        assert_eq!(text("my page"), r#""my page""#);
        assert_eq!(text(""), r#""""#);
    }

    #[test]
    fn quotes_backslashes_and_control_characters_are_escaped_as_json_stringify_does() {
        // Expected values are JSON.stringify's output for the same strings.
        assert_eq!(text(r#"foo "bar"#), r#""foo \"bar""#);
        assert_eq!(text(r"a\b"), r#""a\\b""#);
        assert_eq!(text("line\nnext\ttab\r"), r#""line\nnext\ttab\r""#);
        assert_eq!(text("\u{8}\u{c}"), r#""\b\f""#);
        assert_eq!(text("\u{1}\u{1f}"), r#""\u0001\u001f""#);
        // JSON.stringify leaves DEL, non-ASCII and the line separators as they are.
        assert_eq!(text("\u{7f}é\u{2028}🙂"), "\"\u{7f}é\u{2028}🙂\"");
        // A regex pattern for re-pattern keeps its backslashes doubled once.
        assert_eq!(text(r"(?i)a\.b"), r#""(?i)a\\.b""#);
    }

    #[test]
    fn an_edn_looking_string_stays_a_string() {
        assert_eq!(text("] [?x :block/name"), r#""] [?x :block/name""#);
        assert_eq!(text("#uuid \"x\""), r##""#uuid \"x\"""##);
    }

    #[test]
    fn a_page_name_is_lowercased_when_made_and_sent_as_a_string() {
        assert_eq!(PageName::new("Project Atlas").as_str(), "project atlas");
        assert_eq!(DatalogInput::PageName(PageName::new("ALICE \"B\"")).to_edn(), r#""alice \"b\"""#);
        // Unicode default case conversion, as toLowerCase(): final sigma, dotted capital I.
        assert_eq!(PageName::new("ΟΔΟΣ").as_str(), "οδος");
        assert_eq!(PageName::new("İ").as_str(), "i\u{307}");
        assert_eq!(PageName::new("already lower"), PageName::new("already lower"));
    }

    #[test]
    fn page_names_are_a_vector_of_lowercase_strings() {
        let names = vec![PageName::new("Alice"), PageName::new("project \"Atlas\"")];
        assert_eq!(DatalogInput::PageNames(names).to_edn(), r#"["alice","project \"atlas\""]"#);
        assert_eq!(DatalogInput::PageNames(vec![]).to_edn(), "[]");
    }

    #[test]
    fn a_leaf_suffix_is_a_slash_and_a_lowercase_name() {
        assert_eq!(DatalogInput::LeafSuffix(PageName::new("Retro \"X\"")).to_edn(), r#""/retro \"x\"""#);
    }

    #[test]
    fn a_journal_day_is_a_bare_integer() {
        assert_eq!(DatalogInput::JournalDay(JournalDay::parse(20250101_u32).unwrap()).to_edn(), "20250101");
    }

    #[test]
    fn valid_journal_days_round_trip() {
        for (y, m, d) in [(2025, 1, 1), (2024, 2, 29), (2000, 2, 29), (2025, 12, 31), (1000, 1, 1), (9999, 12, 31)] {
            let day = JournalDay::from_ymd(y, m, d).unwrap();
            assert_eq!(day.ymd(), (y, m, d));
            assert_eq!(JournalDay::parse(day.as_int()).unwrap(), day);
            assert_eq!(JournalDay::parse(format!("{:08}", day.as_int()).as_str()).unwrap(), day);
        }
        assert_eq!(JournalDay::parse("20250101").unwrap().as_int(), 20250101);
        assert_eq!(JournalDay::parse(20250101_i64).unwrap().as_int(), 20250101);
    }

    #[test]
    fn invalid_journal_days_are_refused() {
        for (y, m, d) in [(2025, 13, 1), (2025, 0, 1), (2025, 1, 0), (2025, 1, 32), (2025, 4, 31), (2025, 2, 29), (1900, 2, 29), (0, 1, 1), (1, 1, 1), (999, 12, 31), (10000, 1, 1)] {
            assert!(JournalDay::from_ymd(y, m, d).is_err(), "{y}-{m}-{d}");
        }
        // Fewer than eight digits is not an early year: 10101 would read as 0001-01-01.
        for value in [10101_u32, 1010101, 9991231, 20251399, 20250230, 0, 1735689600, 100000101] {
            assert!(JournalDay::parse(value).is_err(), "{value}");
        }
        for value in [-20250101_i64, 1735689600000, -1, 10101] {
            assert!(JournalDay::parse(value).is_err(), "{value}");
        }
        for value in ["00010101", "09991231", "2025-01-01", "2025011", "202501011", " 20250101", "2025010a", "", "+2025010"] {
            assert!(JournalDay::parse(value).is_err(), "{value:?}");
        }
        assert_eq!(
            JournalDay::parse(20251399_u32).unwrap_err().to_string(),
            "Invalid journal day: 20251399 (expected a calendar date as YYYYMMDD)"
        );
    }

    #[test]
    fn page_ids_are_positive() {
        assert_eq!(PageId::new(42).unwrap().get(), 42);
        assert_eq!(PageId::new(i64::MAX).unwrap().get(), i64::MAX as u64);
        for id in [0, -1, i64::MIN] {
            assert_eq!(PageId::new(id), Err(InvalidValue::PageId(id)));
        }
        assert_eq!(InvalidValue::PageId(0).to_string(), "Invalid entity id: 0 (expected a positive integer)");
    }

    #[test]
    fn block_uuids_are_strict_and_lowercased() {
        let uuid = BlockUuid::parse("6512ABCD-0000-4ABC-8DEF-0123456789AB").unwrap();
        assert_eq!(uuid.as_str(), "6512abcd-0000-4abc-8def-0123456789ab");
        assert_eq!(BlockUuid::parse(uuid.as_str()).unwrap(), uuid);
        for bad in [
            "",
            "6512abcd00004abc8def0123456789ab",
            "6512abcd-0000-4abc-8def-0123456789a",
            "6512abcd-0000-4abc-8def-0123456789abc",
            "6512abcg-0000-4abc-8def-0123456789ab",
            " 6512abcd-0000-4abc-8def-0123456789ab",
            "6512abcd-0000-4abc-8def-0123456789ab\n",
            "6512abcd-0000-4abc-8def\"0123456789ab",
            "{6512abcd-0000-4abc-8def-0123456789ab}",
            "6512abcd-0000-4abc-8def-0123456789aé",
        ] {
            assert!(BlockUuid::parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            BlockUuid::parse("x\"y").unwrap_err().to_string(),
            r#"Invalid block uuid: "x\"y" (expected 8-4-4-4-12 hex digits)"#
        );
    }

    #[test]
    fn ground_clauses_match_the_typescript_builders() {
        let ids = [PageId::new(12).unwrap(), PageId::new(345).unwrap()];
        assert_eq!(ground_ids(&ids, "?p"), "[(ground [12 345]) [?p ...]]");
        assert_eq!(ground_ids(&[], "?id"), "[(ground []) [?id ...]]");
        let uuids = [
            BlockUuid::parse("6512ABCD-0000-4abc-8def-0123456789ab").unwrap(),
            BlockUuid::parse("00000000-0000-0000-0000-000000000000").unwrap(),
        ];
        assert_eq!(
            ground_uuids(&uuids, "?u"),
            r#"[(ground [#uuid "6512abcd-0000-4abc-8def-0123456789ab" #uuid "00000000-0000-0000-0000-000000000000"]) [?u ...]]"#
        );
    }

    #[test]
    #[should_panic(expected = "a Datalog variable")]
    fn a_ground_variable_must_be_a_logic_variable() {
        ground_ids(&[], "?p]) (evil");
    }
}
