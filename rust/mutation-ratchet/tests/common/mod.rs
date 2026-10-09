//! Helpers the integration tests share: a scratch git repository and a stand-in for `cargo mutants --list`.

#![allow(dead_code)]

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use mutation_ratchet::gather::Lister;

static NEXT: AtomicUsize = AtomicUsize::new(0);

pub struct Repo {
    pub root: PathBuf,
}

impl Repo {
    pub fn new() -> Repo {
        let root = std::env::temp_dir().join(format!("mutation-ratchet-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&root).unwrap();
        let repo = Repo { root };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    pub fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    pub fn write(&self, path: &str, text: &str) {
        let full = self.root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }

    pub fn remove(&self, path: &str) {
        fs::remove_file(self.root.join(path)).unwrap();
    }

    pub fn commit(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    /// Merge `branch` into the current one with a merge commit, as a pull request run checks out.
    pub fn merge(&self, branch: &str) -> String {
        self.git(&["merge", "-q", "--no-ff", "-m", "merge", branch]);
        self.git(&["rev-parse", "HEAD"])
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Stands in for `cargo mutants --list --json`: `per_diff_file` mutants for each file the diff changes, and `whole` for a
/// full listing. It remembers what it was asked.
pub struct FakeLister {
    pub per_diff_file: usize,
    pub whole: Vec<(&'static str, usize)>,
    pub asked: RefCell<Vec<Option<String>>>,
}

impl FakeLister {
    pub fn new(per_diff_file: usize, whole: &[(&'static str, usize)]) -> FakeLister {
        FakeLister { per_diff_file, whole: whole.to_vec(), asked: RefCell::new(Vec::new()) }
    }
}

impl Lister for FakeLister {
    fn list(&self, in_diff: Option<&Path>) -> Result<String, String> {
        let mut files: Vec<(String, usize)> = Vec::new();
        match in_diff {
            Some(path) => {
                let diff = fs::read_to_string(path).unwrap();
                self.asked.borrow_mut().push(Some(diff.clone()));
                for line in diff.lines() {
                    if let Some(file) = line.strip_prefix("+++ b/") {
                        files.push((file.to_string(), self.per_diff_file));
                    }
                }
            }
            None => {
                self.asked.borrow_mut().push(None);
                files.extend(self.whole.iter().map(|(f, n)| (f.to_string(), *n)));
            }
        }
        let mutants: Vec<String> = files
            .iter()
            .flat_map(|(file, n)| (0..*n).map(move |_| format!(r#"{{"file":"{file}","name":"x","package":"p"}}"#)))
            .collect();
        Ok(format!("[{}]", mutants.join(",")))
    }
}

