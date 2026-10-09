//! Which lines of a source file are test code, found the way cargo-mutants finds them.
//!
//! The tool makes no mutants from a `#[cfg(test)]` item, a `#[test]` function or anything under one, so a change in
//! those lines can't be measured by `--in-diff`. The plan sorts a changed line into code or test by this, and
//! `cargo-mutants` 27.1.0's own rule is mirrored on purpose (`src/visit.rs`, `attrs_excluded`): an attribute named
//! `cfg` that has the bare word `test` in its list (`#[cfg(test)]`), or an attribute whose path ends in `test`
//! (`#[test]`, `#[tokio::test]`). `#[cfg(all(test, x))]` is not either of those, and the tool does mutate it, so
//! this doesn't call it a test.

use std::fmt;

use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{Attribute, ImplItem, Item, TraitItem};

/// A span of lines, both ends included, 1-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

impl LineRange {
    pub fn contains(&self, line: u32) -> bool {
        self.start <= line && line <= self.end
    }
}

/// What reading one file found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Regions {
    /// Lines inside a test item. A file with `#![cfg(test)]` is one range from line 1.
    pub tests: Vec<LineRange>,
    /// Names of `#[cfg(test)] mod name;` declarations: the module's code is in another file, which is all test.
    pub test_modules: Vec<String>,
}

impl Regions {
    pub fn is_test_line(&self, line: u32) -> bool {
        self.tests.iter().any(|range| range.contains(line))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionError(pub String);

impl fmt::Display for RegionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RegionError {}

/// Read the test regions of a Rust source file. A file that doesn't parse is an error: the plan can't tell code from tests
/// in it, and a guess would decide what a PR is held to.
pub fn read_regions(source: &str) -> Result<Regions, RegionError> {
    let file = syn::parse_file(source).map_err(|err| RegionError(format!("the source doesn't parse: {err}")))?;
    let mut collector = Collector::default();
    if is_test_attrs(&file.attrs) {
        collector.regions.tests.push(LineRange { start: 1, end: u32::MAX });
        return Ok(collector.regions);
    }
    collector.visit_file(&file);
    Ok(collector.regions)
}

#[derive(Default)]
struct Collector {
    regions: Regions,
}

impl Collector {
    fn note(&mut self, span: Span) {
        let start = span.start().line as u32;
        let end = span.end().line as u32;
        self.regions.tests.push(LineRange { start, end });
    }
}

impl<'ast> Visit<'ast> for Collector {
    fn visit_item(&mut self, item: &'ast Item) {
        if !is_test_attrs(item_attrs(item)) {
            syn::visit::visit_item(self, item);
            return;
        }
        if let Item::Mod(module) = item {
            if module.content.is_none() {
                self.regions.test_modules.push(module.ident.to_string());
            }
        }
        self.note(item.span());
    }

    fn visit_impl_item(&mut self, item: &'ast ImplItem) {
        if is_test_attrs(impl_item_attrs(item)) {
            self.note(item.span());
        } else {
            syn::visit::visit_impl_item(self, item);
        }
    }

    fn visit_trait_item(&mut self, item: &'ast TraitItem) {
        if is_test_attrs(trait_item_attrs(item)) {
            self.note(item.span());
        } else {
            syn::visit::visit_trait_item(self, item);
        }
    }
}

fn is_test_attrs(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| is_cfg_test(attr) || path_ends_with_test(attr))
}

fn path_ends_with_test(attr: &Attribute) -> bool {
    attr.path().segments.last().is_some_and(|segment| segment.ident == "test")
}

/// `#[cfg(test)]`, or any `cfg` list with the bare word `test` at its top level. Anything the nested-meta reader can't
/// walk (`all(...)`, `not(...)`, `feature = "x"` with a value is fine) is not a test, as in the tool.
fn is_cfg_test(attr: &Attribute) -> bool {
    if !attr.path().is_ident("cfg") {
        return false;
    }
    let mut has_test = false;
    let walked = attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("test") {
            has_test = true;
        }
        Ok(())
    });
    walked.is_ok() && has_test
}

fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(i) => &i.attrs,
        Item::Enum(i) => &i.attrs,
        Item::ExternCrate(i) => &i.attrs,
        Item::Fn(i) => &i.attrs,
        Item::ForeignMod(i) => &i.attrs,
        Item::Impl(i) => &i.attrs,
        Item::Macro(i) => &i.attrs,
        Item::Mod(i) => &i.attrs,
        Item::Static(i) => &i.attrs,
        Item::Struct(i) => &i.attrs,
        Item::Trait(i) => &i.attrs,
        Item::TraitAlias(i) => &i.attrs,
        Item::Type(i) => &i.attrs,
        Item::Union(i) => &i.attrs,
        Item::Use(i) => &i.attrs,
        _ => &[],
    }
}

fn impl_item_attrs(item: &ImplItem) -> &[Attribute] {
    match item {
        ImplItem::Const(i) => &i.attrs,
        ImplItem::Fn(i) => &i.attrs,
        ImplItem::Type(i) => &i.attrs,
        ImplItem::Macro(i) => &i.attrs,
        _ => &[],
    }
}

fn trait_item_attrs(item: &TraitItem) -> &[Attribute] {
    match item {
        TraitItem::Const(i) => &i.attrs,
        TraitItem::Fn(i) => &i.attrs,
        TraitItem::Type(i) => &i.attrs,
        TraitItem::Macro(i) => &i.attrs,
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "\
pub fn one() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_is_one() {
        assert_eq!(one(), 1);
    }
}

pub fn two() -> u32 {
    2
}
";

    #[test]
    fn a_cfg_test_module_spans_from_its_attribute_to_its_closing_brace() {
        let regions = read_regions(SOURCE).unwrap();
        assert_eq!(regions.tests, vec![LineRange { start: 5, end: 13 }]);
        assert!(regions.is_test_line(5) && regions.is_test_line(13));
        assert!(!regions.is_test_line(4) && !regions.is_test_line(14));
    }

    #[test]
    fn code_around_the_module_is_not_test() {
        let regions = read_regions(SOURCE).unwrap();
        assert!(!regions.is_test_line(2));
        assert!(!regions.is_test_line(16));
    }

    #[test]
    fn a_test_function_outside_a_test_module_is_a_test() {
        let regions = read_regions("fn a() {}\n\n#[test]\nfn t() {\n    a();\n}\n\n#[tokio::test]\nasync fn u() {}\n").unwrap();
        assert_eq!(regions.tests, vec![LineRange { start: 3, end: 6 }, LineRange { start: 8, end: 9 }]);
    }

    #[test]
    fn a_cfg_test_item_inside_an_impl_is_found() {
        let source = "struct S;\nimpl S {\n    fn a(&self) {}\n    #[cfg(test)]\n    fn only_in_tests(&self) {\n    }\n}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![LineRange { start: 4, end: 6 }]);
    }

    #[test]
    fn a_cfg_test_use_and_const_are_tests_too() {
        let source = "#[cfg(test)]\nuse std::fmt;\n#[cfg(test)]\nconst N: u32 = 1;\nfn real() {}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![LineRange { start: 1, end: 2 }, LineRange { start: 3, end: 4 }]);
    }

    #[test]
    fn the_tool_only_counts_the_bare_word_so_all_and_not_are_code() {
        let source = "#[cfg(all(test, unix))]\nfn a() {}\n#[cfg(not(test))]\nfn b() {}\n#[cfg(unix)]\nfn c() {}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![]);
    }

    #[test]
    fn an_inner_cfg_test_makes_the_whole_file_a_test() {
        let regions = read_regions("#![cfg(test)]\nfn a() {}\n").unwrap();
        assert!(regions.is_test_line(1) && regions.is_test_line(2) && regions.is_test_line(4000));
    }

    #[test]
    fn an_out_of_line_test_module_is_named() {
        let regions = read_regions("fn a() {}\n#[cfg(test)]\nmod reading;\n").unwrap();
        assert_eq!(regions.test_modules, vec!["reading".to_string()]);
        assert_eq!(regions.tests, vec![LineRange { start: 2, end: 3 }]);
        let inline = read_regions("#[cfg(test)]\nmod inline {\n}\n").unwrap();
        assert!(inline.test_modules.is_empty());
    }

    #[test]
    fn a_nested_test_module_is_one_region_not_two() {
        let source = "#[cfg(test)]\nmod outer {\n    #[cfg(test)]\n    mod inner {\n        fn a() {}\n    }\n}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![LineRange { start: 1, end: 7 }]);
    }

    #[test]
    fn a_test_module_nested_in_a_plain_module_is_found() {
        let source = "mod plain {\n    pub fn a() {}\n    #[cfg(test)]\n    mod tests {\n    }\n}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![LineRange { start: 3, end: 5 }]);
    }

    #[test]
    fn braces_and_strings_in_the_module_do_not_end_it_early() {
        let source = "#[cfg(test)]\nmod tests {\n    const S: &str = \"}\";\n    fn a() { let _ = '}'; }\n}\nfn after() {}\n";
        assert_eq!(read_regions(source).unwrap().tests, vec![LineRange { start: 1, end: 5 }]);
    }

    #[test]
    fn a_file_that_does_not_parse_is_an_error() {
        assert!(read_regions("fn a( {").is_err());
    }
}
