//! The three commands the workflows call. Each reads its arguments, does its work through the pure modules and writes files
//! into an output directory the workflow then reads or uploads; nothing is decided in shell.
//!
//! ```text
//! mutation-ratchet plan      --repo DIR --out DIR [--limits FILE] [--base SHA] [--proof]
//! mutation-ratchet full-plan --repo DIR --out DIR --index K [--limits FILE] [--slices N]
//! mutation-ratchet report    --plan FILE --results DIR --out DIR [--head SHA] [--tool-version V]
//! mutation-ratchet measure   --label NAME --outcomes FILE [--wall SECONDS]
//! mutation-ratchet test-times --log FILE
//! ```
//!
//! The last two are for the measurement runs of #364 PR 1: they print counts and seconds, never a name from a graph.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::exit::{self, Exit};
use crate::gather::{CargoMutants, Git, Lister, plan_from};
use crate::limits::{self, Limits};
use crate::measure;
use crate::outcomes;
use crate::plan::{Group, Item, Kind, Mode, Plan, proof_plan};
use crate::report::{RunResult, count_mismatches, render_plan, render_results};
use crate::slices::slice_files;
use crate::testtimes;

/// `--key value` pairs and bare `--flag`s.
pub struct Args {
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

const FLAGS: &[&str] = &["proof"];

impl Args {
    pub fn parse(args: &[String]) -> Result<Args, String> {
        let mut values = BTreeMap::new();
        let mut flags = BTreeSet::new();
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            let Some(name) = arg.strip_prefix("--") else {
                return Err(format!("unexpected argument {arg:?}"));
            };
            if FLAGS.contains(&name) {
                flags.insert(name.to_string());
            } else {
                let value = iter.next().ok_or_else(|| format!("--{name} needs a value"))?;
                if values.insert(name.to_string(), value.clone()).is_some() {
                    return Err(format!("--{name} is given twice"));
                }
            }
        }
        Ok(Args { values, flags })
    }

    fn required(&self, name: &str) -> Result<&str, String> {
        self.values.get(name).map(String::as_str).ok_or_else(|| format!("--{name} is required"))
    }

    fn optional(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

fn read_limits(args: &Args, repo: &Path) -> Result<Limits, String> {
    let path = match args.optional("limits") {
        Some(path) => PathBuf::from(path),
        None => repo.join("rust/mutation-ratchet/limits.env"),
    };
    let text = fs::read_to_string(&path).map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    let limits = limits::parse(&text).map_err(|e| e.to_string())?;
    limits.check().map_err(|e| e.to_string())?;
    Ok(limits)
}

/// `--repo` and `--out` as absolute paths: the tool runs in another directory, so a relative path to the diff it reads would
/// point somewhere else.
fn repo_and_out(args: &Args) -> Result<(PathBuf, PathBuf), String> {
    let repo = PathBuf::from(args.required("repo")?);
    let out = PathBuf::from(args.required("out")?);
    fs::create_dir_all(&out).map_err(|e| format!("couldn't create {}: {e}", out.display()))?;
    let repo = fs::canonicalize(&repo).map_err(|e| format!("couldn't resolve {}: {e}", repo.display()))?;
    let out = fs::canonicalize(&out).map_err(|e| format!("couldn't resolve {}: {e}", out.display()))?;
    Ok((repo, out))
}

fn write(out: &Path, name: &str, text: &str) -> Result<(), String> {
    fs::write(out.join(name), text).map_err(|e| format!("couldn't write {name}: {e}"))
}

fn lines(files: &[&str]) -> String {
    files.iter().map(|f| format!("{f}\n")).collect()
}

/// `plan`: what this pull request's run measures. Writes `plan.json`, `summary.md`, `base-sha.txt`, `in-diff.diff` (when some
/// file is measured by its changed lines), `in-diff-files.txt`, `whole-files.txt` and `plan.env` into `--out`.
pub fn plan_command(args: &Args, lister: &dyn Lister) -> Result<String, String> {
    let (repo, out) = repo_and_out(args)?;
    let limits = read_limits(args, &repo)?;
    let git = Git { root: repo };
    let base = match args.optional("base") {
        Some(base) => git.rev_parse(base)?,
        None => git.base_of_merge_commit()?,
    };
    let (pr_plan, _) = plan_from(&git, lister, &base, limits.mutant_budget, &out)?;
    let plan = if args.flag("proof") { proof_plan(&pr_plan) } else { pr_plan };

    write(&out, "base-sha.txt", &format!("{base}\n"))?;
    let in_diff = plan.in_diff_files();
    if !in_diff.is_empty() {
        write(&out, "in-diff.diff", &git.diff_for(&base, &in_diff)?)?;
    }
    write(&out, "in-diff-files.txt", &lines(&in_diff))?;
    write(&out, "whole-files.txt", &lines(&plan.whole_files()))?;
    write_plan_files(&out, &plan)?;
    Ok(render_plan(&plan))
}

/// `full-plan`: one slice of a full run (ADR-0033 "Slices").
pub fn full_plan_command(args: &Args, lister: &dyn Lister) -> Result<String, String> {
    let (repo, out) = repo_and_out(args)?;
    let limits = read_limits(args, &repo)?;
    let slices_wanted = match args.optional("slices") {
        Some(n) => n.parse::<usize>().map_err(|_| "--slices is not a whole number".to_string())?,
        None => limits.full_run_slices as usize,
    };
    let index: usize = args.required("index")?.parse().map_err(|_| "--index is not a whole number".to_string())?;
    let counts = crate::listing::count_by_file(&lister.list(None)?).map_err(|e| e.to_string())?;
    let slices = slice_files(&counts, slices_wanted);
    let files = slices.get(index).ok_or_else(|| format!("--index {index} is outside the {} slices", slices.len()))?;
    let selected: Vec<Item> =
        files.iter().map(|file| Item { file: file.clone(), group: Group::Full, mode: Mode::Whole, mutants: counts[file] }).collect();
    let plan = Plan {
        kind: Kind::Full,
        budget: None,
        selected,
        left_out: vec![],
        no_mutants: vec![],
        deleted_sources: vec![],
        tests_left_to_full_run: vec![],
        tests_added: 0,
        tests_only_added_in: vec![],
    };
    write(&out, "in-diff-files.txt", "")?;
    write(&out, "whole-files.txt", &lines(&plan.whole_files()))?;
    write_plan_files(&out, &plan)?;
    let mut summary = render_plan(&plan);
    summary.push_str(&format!("\nSlice {} of {} (whole files balanced by mutant count).\n", index + 1, slices.len()));
    Ok(summary)
}

fn write_plan_files(out: &Path, plan: &Plan) -> Result<(), String> {
    write(out, "plan.json", &serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?)?;
    let summary = render_plan(plan);
    write(out, "summary.md", &summary)?;
    let proof_needed = plan.left_out.iter().filter(|l| l.requires_proof).count();
    let env = format!(
        "IN_DIFF_FILES={}\nWHOLE_FILES={}\nSELECTED_MUTANTS={}\nNOTHING_SELECTED={}\nLEFT_OUT_NEEDS_PROOF={}\n",
        plan.in_diff_files().len(),
        plan.whole_files().len(),
        plan.selected_mutants(),
        plan.selected.is_empty(),
        proof_needed
    );
    write(out, "plan.env", &env)
}

/// What `report` found: the text for the job summary, and every reason the job should fail.
pub struct Reported {
    pub summary: String,
    pub failures: Vec<String>,
}

/// `report`: read what the tool wrote for each `cargo mutants` call the plan asked for, and say what it measured.
///
/// `--results` holds one directory per call, named for the mode (`in-diff`, `whole`), each with the exit code the workflow
/// recorded (`exit`) and the tool's `mutants.out/outcomes.json`. It writes `summary.md`, `report.json` and, for a proof or
/// full run, `measured-files.json` (the files whose mutants it measured, which the ratchet reads to accept a proof).
pub fn report_command(args: &Args) -> Result<Reported, String> {
    let plan_path = PathBuf::from(args.required("plan")?);
    let results = PathBuf::from(args.required("results")?);
    let out = PathBuf::from(args.required("out")?);
    fs::create_dir_all(&out).map_err(|e| format!("couldn't create {}: {e}", out.display()))?;
    let plan: Plan = serde_json::from_str(&fs::read_to_string(&plan_path).map_err(|e| format!("couldn't read the plan: {e}"))?)
        .map_err(|e| format!("the plan is not valid: {e}"))?;

    let mut failures: Vec<String> = Vec::new();
    let mut runs: Vec<RunResult> = Vec::new();
    for (name, mode) in [("in-diff", Mode::InDiff), ("whole", Mode::Whole)] {
        if !plan.selected.iter().any(|item| item.mode == mode) {
            continue;
        }
        let dir = results.join(name);
        let exit = match fs::read_to_string(dir.join("exit")) {
            Ok(text) => match exit::parse_recorded(&text) {
                Ok(code) => exit::classify(code),
                Err(why) => {
                    failures.push(format!("the {name} run: {why}"));
                    Exit::Broken("its recorded exit code is unreadable")
                }
            },
            Err(_) => {
                failures.push(format!("the {name} run recorded no exit code, so it didn't finish"));
                Exit::Broken("it recorded no exit code")
            }
        };
        if let Exit::Broken(why) = exit {
            failures.push(format!("the {name} run failed: {why}"));
        }
        let outcomes = match fs::read_to_string(dir.join("mutants.out/outcomes.json")) {
            Ok(text) => match outcomes::parse(&text) {
                Ok(parsed) => Some(parsed),
                Err(e) => {
                    failures.push(format!("the {name} run's outcomes.json is unusable: {e}"));
                    None
                }
            },
            Err(_) => {
                if !exit.fails_the_job() {
                    failures.push(format!("the {name} run wrote no outcomes.json"));
                }
                None
            }
        };
        if let Some(parsed) = &outcomes {
            if parsed.baseline.is_some_and(|b| !b.succeeded) {
                failures.push(format!("the {name} run's unmutated baseline failed"));
            }
            if let Some(expected) = args.optional("tool-version") {
                if parsed.tool_version != expected {
                    failures.push(format!("the {name} run used cargo-mutants {}, not {expected}", parsed.tool_version));
                }
            }
        }
        runs.push(RunResult { name, exit, outcomes });
    }

    let mut summary = render_plan(&plan);
    if !runs.is_empty() {
        summary.push_str(&render_results(&plan, &runs));
    }
    for failure in &failures {
        summary.push_str(&format!("\n**Failed:** {failure}.\n"));
    }

    let mismatches = count_mismatches(&plan, &runs);
    let mut files = json!({});
    let mut measured: Vec<String> = Vec::new();
    for run in &runs {
        if let Some(parsed) = &run.outcomes {
            for (file, counts) in &parsed.per_file {
                measured.push(file.clone());
                files[file] = json!({
                    "caught": counts.caught, "missed": counts.missed, "timeout": counts.timeout, "unviable": counts.unviable,
                    "score": counts.score(), "run": run.name,
                });
            }
        }
    }
    measured.sort();
    measured.dedup();
    let head = args.optional("head");
    let kind = serde_json::to_value(plan.kind).map_err(|e| e.to_string())?;
    let report = json!({
        "kind": kind,
        "head": head,
        "files": files,
        "count_mismatches": mismatches,
        "left_out": plan.left_out.iter().map(|l| json!({
            "file": l.item.file, "group": l.item.group, "requires_proof": l.requires_proof,
        })).collect::<Vec<_>>(),
        "failures": failures,
    });
    write(&out, "report.json", &serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?)?;
    write(&out, "measured-files.json", &serde_json::to_string_pretty(&json!({ "kind": kind, "head": head, "files": measured })).map_err(|e| e.to_string())?)?;
    write(&out, "summary.md", &summary)?;
    Ok(Reported { summary, failures })
}

/// The command line: the first argument is the command. Returns the text for standard output, or the reason to fail.
pub fn main_with(args: &[String]) -> Result<String, String> {
    let Some((command, rest)) = args.split_first() else {
        return Err(usage());
    };
    let parsed = Args::parse(rest)?;
    match command.as_str() {
        "plan" | "full-plan" => {
            let crate_dir = PathBuf::from(parsed.required("repo")?).join("rust");
            let lister = CargoMutants { crate_dir };
            if command == "plan" { plan_command(&parsed, &lister) } else { full_plan_command(&parsed, &lister) }
        }
        "report" => {
            let reported = report_command(&parsed)?;
            if reported.failures.is_empty() {
                Ok(reported.summary)
            } else {
                // The summary goes to the job summary through summary.md; the failures are what the log must say.
                Err(format!("{}\n{}", reported.summary, reported.failures.join("\n")))
            }
        }
        "measure" => measure_command(&parsed),
        "test-times" => test_times_command(&parsed),
        "help" | "--help" => Ok(usage()),
        other => Err(format!("unknown command {other:?}\n{}", usage())),
    }
}

/// `measure`: one table row, and the mutants per file group, for a run's outcomes.json.
fn measure_command(args: &Args) -> Result<String, String> {
    let path = args.required("outcomes")?;
    let text = fs::read_to_string(path).map_err(|e| format!("couldn't read {path}: {e}"))?;
    let outcomes = outcomes::parse(&text).map_err(|e| e.to_string())?;
    let wall = match args.optional("wall") {
        Some(seconds) => Some(seconds.parse::<f64>().map_err(|_| "--wall is not a number of seconds".to_string())?),
        None => None,
    };
    Ok(format!(
        "{}\n{}\n\n{}",
        measure::HEADER,
        measure::row(args.required("label")?, &outcomes, wall),
        measure::size_summary(&outcomes)
    ))
}

/// `test-times`: seconds per test binary in the tool's baseline log, slowest first.
fn test_times_command(args: &Args) -> Result<String, String> {
    let path = args.required("log")?;
    let text = fs::read_to_string(path).map_err(|e| format!("couldn't read {path}: {e}"))?;
    let mut times = testtimes::per_binary(&text);
    times.sort_by(|a, b| b.1.total_cmp(&a.1));
    let total: f64 = times.iter().map(|(_, seconds)| seconds).sum();
    let mut out = format!("{} test binaries, {total:.1} s in all.\n", times.len());
    for (name, seconds) in &times {
        out.push_str(&format!("{seconds:.2} s  {name}\n"));
    }
    Ok(out)
}

fn usage() -> String {
    [
        "usage:",
        "  mutation-ratchet plan       --repo DIR --out DIR [--limits FILE] [--base SHA] [--proof]",
        "  mutation-ratchet full-plan  --repo DIR --out DIR --index K [--limits FILE] [--slices N]",
        "  mutation-ratchet report     --plan FILE --results DIR --out DIR [--head SHA] [--tool-version V]",
        "  mutation-ratchet measure    --label NAME --outcomes FILE [--wall SECONDS]",
        "  mutation-ratchet test-times --log FILE",
    ]
    .join("\n")
}
