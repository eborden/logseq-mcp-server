//! The link checker's LogSeq traffic against a mock LogSeq on a local port: how many calls it makes
//! and with which inputs. The Rust side of the call counts in `CLAUDE.md` ("Current Implementation
//! Status": `check_links` is 0-1 calls); the parity harness (`scripts/parity.ts`) checks the same
//! calls and the result bytes against the TypeScript server. Every page here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::check_links::check_links;
use serde_json::{Value, json};

fn page(id: i64, name: &str, original: &str, file: bool) -> Value {
    let mut page = json!({"id": id, "name": name, "original-name": original});
    if file {
        page["file"] = json!({"id": id + 5000});
    }
    page
}

#[tokio::test]
async fn a_text_with_no_terms_makes_no_call() {
    let logseq = mock_logseq(vec![]).await;
    let result = check_links(&client(&logseq), "plain text", "plain text").await.unwrap();
    assert!(methods(&logseq).is_empty());
    assert_eq!(result["ok"], true);
    assert_eq!(result["refs"], json!({"ok": true, "resolved": [], "unresolved": [], "ambiguous": []}));
    assert_eq!(result["totals"], json!({"refsBefore": 0, "refsAfter": 0, "terms": 0}));
}

#[tokio::test]
async fn however_many_terms_there_are_one_query_binds_them_as_one_sorted_collection() {
    let logseq = mock_logseq(vec![json!([
        [page(1, "alice", "Alice", true), "name", "alice"],
        [page(2, "bob", "Bob", true), "name", "bob"],
        [page(3, "robert", "Robert", true), "alias", "rob"],
    ])])
    .await;
    let after = "[[Bob]] met [[alice]] and [[Rob]] and [[ Alice ]] and [[bob]]";
    let result = check_links(&client(&logseq), &after.replace("[[", "").replace("]]", ""), after).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    // the terms sort by code unit as written; the names bound are trimmed, lowercased and distinct
    assert_eq!(args_of(&logseq, 0)[1], json!("[\"alice\",\"bob\",\"rob\"]"));
    assert!(args_of(&logseq, 0)[0].as_str().unwrap().contains(":in $ [?n ...] :where"));
    assert_eq!(result["refs"]["resolved"].as_array().unwrap().len(), 5);
    assert_eq!(result["refs"]["resolved"][0], json!({"term": " Alice ", "page": "Alice", "matchedBy": "name"}));
    assert_eq!(result["refs"]["resolved"][2], json!({"term": "Rob", "page": "Robert", "matchedBy": "alias"}));
    assert_eq!(result["totals"], json!({"refsBefore": 0, "refsAfter": 5, "terms": 5}));
}

#[tokio::test]
async fn a_name_with_no_page_is_unresolved_and_a_file_less_page_is_a_page() {
    let logseq = mock_logseq(vec![json!([[page(1, "stub", "Stub", false), "name", "stub"]])]).await;
    let result = check_links(&client(&logseq), "stub ghost", "[[stub]] [[ghost]]").await.unwrap();
    assert_eq!(result["refs"]["resolved"], json!([{"term": "stub", "page": "Stub", "matchedBy": "name"}]));
    assert_eq!(result["refs"]["unresolved"], json!(["ghost"]));
    assert_eq!(result["refs"]["ok"], false);
    assert_eq!(result["ok"], false);
}

#[tokio::test]
async fn an_alias_several_pages_declare_is_ambiguous_and_only_a_new_copy_fails() {
    let rows = json!([
        [page(1, "alice", "Alice", true), "alias", "al"],
        [page(2, "alice notes", "Alice Notes", true), "alias", "al"],
    ]);
    // new: the pass added the ref
    let logseq = mock_logseq(vec![rows.clone()]).await;
    let added = check_links(&client(&logseq), "al", "[[al]]").await.unwrap();
    assert_eq!(added["refs"]["ambiguous"], json!([{"term": "al", "candidates": ["Alice", "Alice Notes"], "totalCandidates": 2, "preexisting": false}]));
    assert_eq!(added["refs"]["ok"], false);

    // preexisting: `before` already linked it and no copy was added
    let logseq = mock_logseq(vec![rows]).await;
    let kept = check_links(&client(&logseq), "[[al]]", "[[al]]").await.unwrap();
    assert_eq!(kept["refs"]["ambiguous"][0]["preexisting"], true);
    assert_eq!(kept["refs"]["ok"], true);
    assert_eq!(kept["ok"], true);
}

#[tokio::test]
async fn a_cut_candidate_list_adds_a_warning() {
    let rows: Vec<Value> = (0..12).map(|i| json!([page(100 + i, &format!("p{i:02}"), &format!("P{i:02}"), true), "alias", "al"])).collect();
    let logseq = mock_logseq(vec![Value::Array(rows)]).await;
    let result = check_links(&client(&logseq), "al", "[[al]]").await.unwrap();
    assert_eq!(result["refs"]["ambiguous"][0]["totalCandidates"], 12);
    assert_eq!(result["refs"]["ambiguous"][0]["candidates"].as_array().unwrap().len(), 10);
    assert_eq!(result["warnings"][0]["code"], "candidates_truncated");
    assert_eq!(
        result["warnings"][0]["message"],
        "[[al]] is an alias of 12 pages. Showing 10, the most this lists; the rest can't be fetched in one call."
    );
    assert_eq!(result["hasMore"], false);
}

#[tokio::test]
async fn a_null_answer_is_not_checked_and_never_reported_as_missing_pages() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let result = check_links(&client(&logseq), "alice bob", "[[alice]] [[bob]]").await.unwrap();
    assert_eq!(result["refs"], json!({"ok": false, "resolved": [], "unresolved": [], "ambiguous": []}));
    assert_eq!(result["warnings"][0]["code"], "refs_unchecked");
    assert_eq!(result["ok"], false);
}

#[tokio::test]
async fn more_than_five_hundred_distinct_terms_are_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    let after: String = (0..501).map(|i| format!("[[page {i}]]")).collect();
    let error = check_links(&client(&logseq), "", &after).await.unwrap_err();
    assert!(matches!(error, ToolError::InvalidParameter(_)));
    assert_eq!(error.to_string(), "Invalid parameter 'after': 501 distinct [[terms]]\n\nExpected: at most 500 distinct [[terms]]. Check the text in parts");
    assert!(methods(&logseq).is_empty());
    // 500 distinct names pass the cap, however many spellings
    let at_cap: String = (0..500).map(|i| format!("[[page {i}]]")).collect::<String>() + "[[PAGE 0]]";
    let logseq = mock_logseq(vec![json!([])]).await;
    assert!(check_links(&client(&logseq), "", &at_cap).await.is_ok());
    assert_eq!(methods(&logseq).len(), 1);
}
