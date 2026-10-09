//! How long each test binary of `cargo test` took, from the tool's baseline log (`mutants.out/log/baseline.log`).
//!
//! #364 asks whether the guard tests are worth skipping (ADR-0033 "Tool and scope": only if a measurement shows they cost time
//! or flake). The baseline runs the whole suite once with no mutation, so its log says what each binary costs. A binary shows as
//! `Running tests/name.rs (target/...)` or `Running unittests src/lib.rs (...)`, and the line `test result: ... finished in 1.23s`
//! after it is its time.

/// `(binary, seconds)` in the order they ran. A binary with no result line (a build failure) is left out.
pub fn per_binary(log: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in log.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Running ") {
            current = rest.split(" (").next().map(str::to_string);
        } else if line.starts_with("test result:") {
            if let (Some(name), Some(seconds)) = (current.take(), finished_in(line)) {
                out.push((name, seconds));
            }
        }
    }
    out
}

fn finished_in(line: &str) -> Option<f64> {
    let rest = line.split("finished in ").nth(1)?;
    rest.trim().trim_end_matches('s').parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "\
   Compiling x v0.1.0
    Finished `test` profile [unoptimized + debuginfo] target(s) in 61.20s
     Running unittests src/lib.rs (target/debug/deps/x-1234)

running 3 tests
test a ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.52s

     Running tests/no_stdout.rs (target/debug/deps/no_stdout-5678)

running 1 test
test t ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 12.00s

   Doc-tests x

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
";

    #[test]
    fn each_binary_gets_the_time_of_its_result_line() {
        assert_eq!(per_binary(LOG), vec![("unittests src/lib.rs".to_string(), 0.52), ("tests/no_stdout.rs".to_string(), 12.0)]);
    }

    #[test]
    fn a_log_with_no_test_run_has_no_times() {
        assert_eq!(per_binary(""), vec![]);
        assert_eq!(per_binary("error: could not compile\n"), vec![]);
    }

    #[test]
    fn a_result_line_without_a_time_is_left_out() {
        assert_eq!(per_binary("Running tests/a.rs (x)\ntest result: FAILED. 0 passed; 1 failed\n"), vec![]);
    }
}
