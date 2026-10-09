//! Tests of the reader every wire type is written with: what it reads, what it says when an answer is not
//! the shape asked for, and that it never says a value from the answer (ADR-0004).

use serde::Deserialize;
use serde_json::{Value, json};

use super::{Id, Number, Object, Optional, ResponseError, check, parse};

const METHOD: &str = "logseq.Test.method";

/// What a type reports for an answer as `path: problem`.
fn problem<T: serde::de::DeserializeOwned + std::fmt::Debug>(answer: Value) -> String {
    let error = parse::<T>(METHOD, &answer).unwrap_err();
    format!("{}: {}", error.path, error.problem)
}

/// A page-like object: one field that must be there, one that may be left out, one that is a list of
/// objects, and a renamed key.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Page {
    id: Id,
    #[serde(default)]
    name: Optional<String>,
    #[serde(default)]
    links: Optional<Vec<Link>>,
    #[serde(default, rename = "original-name")]
    original_name: Optional<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Link {
    #[serde(default)]
    id: Optional<Id>,
}

#[test]
fn a_value_of_another_kind_is_named_by_kind_in_our_words() {
    assert_eq!(problem::<String>(json!(5)), "answer: expected a string, got a number");
    assert_eq!(problem::<String>(json!(null)), "answer: expected a string, got null");
    assert_eq!(problem::<bool>(json!("yes")), "answer: expected a boolean, got a string");
    assert_eq!(problem::<Vec<String>>(json!({})), "answer: expected a list, got an object");
    assert_eq!(problem::<Object>(json!([])), "answer: expected an object, got a list");
    assert_eq!(problem::<Number>(json!("1")), "answer: expected a number, got a string");
    assert_eq!(problem::<Page>(json!(true)), "answer: expected an object, got a boolean");
}

#[test]
fn the_path_is_the_way_into_the_answer() {
    assert_eq!(problem::<Page>(json!({"id": "x"})), "answer.id: expected a whole number, got a string");
    assert_eq!(problem::<Page>(json!({"id": 1, "original-name": 3})), "answer.original-name: expected a string, got a number");
    assert_eq!(problem::<Vec<Page>>(json!([{"id": 1}, {"id": 2, "links": [{"id": 1}, {"id": null}]}])), "answer[1].links[1].id: expected a whole number, got null");
    assert_eq!(problem::<Vec<Vec<Page>>>(json!([[], [{"id": []}]])), "answer[1][0].id: expected a whole number, got a list");
}

#[test]
fn a_field_that_is_not_there_is_missing_at_its_own_path() {
    assert_eq!(problem::<Page>(json!({})), "answer.id: required, but missing");
    assert_eq!(problem::<Vec<Page>>(json!([{"name": "a"}])), "answer[0].id: required, but missing");
}

#[test]
fn a_field_that_may_be_left_out_may_not_be_null() {
    let page: Page = parse(METHOD, &json!({"id": 1})).unwrap();
    assert!(page.name.into_option().is_none() && page.links.into_option().is_none());
    assert_eq!(problem::<Page>(json!({"id": 1, "name": null})), "answer.name: expected a string, got null");
    assert_eq!(problem::<Page>(json!({"id": 1, "links": null})), "answer.links: expected a list, got null");
    assert_eq!(problem::<Page>(json!({"id": 1, "links": [null]})), "answer.links[0]: expected an object, got null");
    // `null` is `None` only where a type says `Option`, which is what a nullable answer is (BR-0011)
    assert_eq!(parse::<Option<Vec<Page>>>(METHOD, &json!(null)).unwrap().map(|pages| pages.len()), None);
    assert_eq!(parse::<Option<Vec<Page>>>(METHOD, &json!([])).unwrap().map(|pages| pages.len()), Some(0));
    assert_eq!(problem::<Vec<Page>>(json!(null)), "answer: expected a list, got null");
}

#[test]
fn keys_the_type_does_not_name_are_not_read() {
    let answer = json!({"id": 1, "extra": {"deep": [1, {"a": null}]}, "uuid": 5, "children": "x", "name": "a"});
    let page: Page = parse(METHOD, &answer).unwrap();
    assert_eq!(page.name.into_option().as_deref(), Some("a"));
    assert!(check::<Page>(METHOD, &answer).is_ok());
}

#[test]
fn an_id_is_a_whole_number_up_to_2_to_the_53() {
    for (answer, read) in [(json!(5), 5), (json!(5.0), 5), (json!(1e3), 1000), (json!(0), 0), (json!(-3), -3), (json!(9007199254740992u64), 9_007_199_254_740_992)] {
        assert_eq!(parse::<Id>(METHOD, &answer).unwrap(), Id(read), "{answer}");
    }
    assert_eq!(problem::<Id>(json!(1.5)), "answer: expected a whole number, got a number with a fraction");
    assert_eq!(problem::<Id>(json!(1e300)), "answer: expected a whole number no larger than 2^53, got a number out of range");
    assert_eq!(problem::<Id>(json!(9007199254740993u64)), "answer: expected a whole number no larger than 2^53, got a number out of range");
    assert_eq!(problem::<Id>(json!(-9007199254740993i64)), "answer: expected a whole number no larger than 2^53, got a number out of range");
    assert_eq!(problem::<Id>(json!("5")), "answer: expected a whole number, got a string");
    // the test the readers use is the same one
    for answer in [json!(5), json!(5.0), json!(1.5), json!(1e300), json!(9007199254740993u64), json!("5")] {
        assert_eq!(parse::<Id>(METHOD, &answer).ok().map(|id| id.0), super::whole_number(&answer), "{answer}");
    }
}

#[test]
fn a_row_has_exactly_the_cells_its_type_reads() {
    type Row = (Id, String);
    assert_eq!(parse::<Row>(METHOD, &json!([1, "a"])).unwrap(), (Id(1), "a".to_owned()));
    assert_eq!(problem::<Row>(json!([1])), "answer: the row has fewer cells than this server reads");
    assert_eq!(problem::<Row>(json!([])), "answer: the row has fewer cells than this server reads");
    assert_eq!(problem::<Row>(json!([1, "a", 3])), "answer: the row has more cells than this server reads");
    assert_eq!(problem::<Row>(json!({"a": 1})), "answer: expected a row, got an object");
    assert_eq!(problem::<Vec<Row>>(json!([[1, "a"], 5])), "answer[1]: expected a row, got a number");
    assert_eq!(problem::<Vec<Row>>(json!([[1, "a"], [2]])), "answer[1]: the row has fewer cells than this server reads");
    // a cell is named by its place in the row
    assert_eq!(problem::<Vec<Row>>(json!([[1, "a"], [2, 7]])), "answer[1][1]: expected a string, got a number");
    // the cells are checked before the length, so the first thing wrong in the answer's order is the one said
    assert_eq!(problem::<Row>(json!(["x", "a", 3])), "answer[0]: expected a whole number, got a string");
}

#[derive(Debug, PartialEq, Deserialize)]
enum Direction {
    #[serde(rename = "outbound")]
    Outbound,
    #[serde(rename = "inbound")]
    Inbound,
}

#[test]
fn a_name_a_type_does_not_know_is_a_different_string_and_is_not_quoted() {
    assert_eq!(parse::<Direction>(METHOD, &json!("inbound")).unwrap(), Direction::Inbound);
    assert_eq!(problem::<Direction>(json!("SECRET")), "answer: expected \"outbound\" or \"inbound\", got a different string");
    assert_eq!(problem::<Direction>(json!(4)), "answer: expected a string, got a number");
}

#[test]
fn no_value_from_the_answer_is_in_any_message() {
    const SECRET: &str = "Zebra Secret 42";
    let wrong: Vec<(&str, Value)> = vec![
        ("a string for a whole number", json!({"id": SECRET})),
        ("a string in a nested id", json!({"id": 1, "links": [{"id": SECRET}]})),
        ("a string for a list", json!({"id": 1, "links": SECRET})),
        ("a string for an object", json!({"id": 1, "links": [SECRET]})),
        ("a name nobody knows", json!(SECRET)),
        ("a secret key", json!({"id": 1, SECRET: 5, "name": 5})),
        ("a secret in a skipped field", json!({"id": SECRET, "extra": SECRET})),
        ("a secret row", json!([[SECRET]])),
    ];
    for (what, answer) in wrong {
        for error in [
            parse::<Page>(METHOD, &answer).err(),
            parse::<Vec<Page>>(METHOD, &answer).err(),
            parse::<(Id, String)>(METHOD, &answer).err(),
            parse::<Vec<(Id, String)>>(METHOD, &answer).err(),
            parse::<Direction>(METHOD, &answer).err(),
            parse::<Id>(METHOD, &answer).err(),
            parse::<Object>(METHOD, &answer).err(),
        ]
        .into_iter()
        .flatten()
        {
            let message = error.to_string();
            assert!(!message.contains(SECRET) && !message.contains("Zebra"), "{what}: {message}");
        }
    }
}

#[test]
fn the_message_names_the_method_the_path_and_the_problem() {
    let error: ResponseError = parse::<Vec<Page>>("logseq.Editor.getAllPages", &json!([{"id": 1}, {"id": "x"}])).unwrap_err();
    assert_eq!((error.method.as_str(), error.path.as_str(), error.problem.as_str()), ("logseq.Editor.getAllPages", "answer[1].id", "expected a whole number, got a string"));
    assert!(error.to_string().starts_with(
        "LogSeq answered logseq.Editor.getAllPages in a shape this server can't read: answer[1].id: expected a whole number, got a string\n\nSteps to fix:\n1. "
    ));
}

#[test]
fn a_key_that_is_not_a_field_the_type_names_is_never_in_the_path() {
    // a map of the user's own keys (properties, page names): its keys are the graph, and stay out
    let said = problem::<std::collections::HashMap<String, Id>>(json!({"Alice's private page": "x"}));
    assert_eq!(said, "answer: expected a whole number, got a string");
    let said = problem::<std::collections::BTreeMap<String, Vec<Id>>>(json!({"journal 2025-01-01": [1, "x"]}));
    assert_eq!(said, "answer[1]: expected a whole number, got a string");
    // a struct names its fields: those are in the path, and an unknown key whose name looks like data is skipped
    // without being read, and is not said when a field next to it fails
    let answer = json!({"Alice's private page": {"deep": [1, 2]}, "id": "x"});
    assert_eq!(problem::<Page>(answer), "answer.id: expected a whole number, got a string");
    assert!(parse::<Page>(METHOD, &json!({"Alice's private page": "anything", "id": 1})).is_ok());
}
