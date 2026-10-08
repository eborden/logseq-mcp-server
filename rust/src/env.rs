//! The process environment, read once at startup into a typed [`Env`]. Nothing else in the
//! crate reads an environment variable or the home directory (`tests/env_reads.rs` checks it),
//! so every setting the server takes from its environment is listed here and parsed here.
//!
//! The rules match `resolveConfigPath` and `resolveTipsEnabled` in `src/config.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::ConfigError;

/// Environment variable naming another config file (#118).
pub const CONFIG_PATH_ENV: &str = "LOGSEQ_MCP_CONFIG";

/// Environment variable that turns next-step tips (#44) on or off over the config file's `tips`.
pub const TIPS_ENV: &str = "LOGSEQ_MCP_TIPS";

const TIPS_ON_VALUES: [&str; 4] = ["1", "true", "on", "yes"];
const TIPS_OFF_VALUES: [&str; 4] = ["0", "false", "off", "no"];

/// What the server takes from its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Env {
    pub config_path: ConfigPath,
    pub tips: TipsOverride,
}

/// The config file's path. Absolute by construction: the MCP client picks the server's working
/// directory, so a relative path would not name the same file everywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPath(PathBuf);

impl ConfigPath {
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// `LOGSEQ_MCP_TIPS`, which overrides the config file's `tips` when set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipsOverride {
    /// Unset or blank: the config file decides.
    Unset,
    On,
    Off,
}

impl TipsOverride {
    /// Whether tips are on, given the config file's `tips`: on unless one of them turns them off,
    /// and the variable wins over the file.
    pub fn tips_enabled(self, config_tips: Option<bool>) -> bool {
        match self {
            TipsOverride::On => true,
            TipsOverride::Off => false,
            TipsOverride::Unset => config_tips != Some(false),
        }
    }
}

impl Env {
    /// Read the process environment. The one place in the crate that does.
    pub fn from_process() -> Result<Env, ConfigError> {
        let vars: HashMap<String, String> = [CONFIG_PATH_ENV, TIPS_ENV]
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|value| (key.to_owned(), value.to_string_lossy().into_owned())))
            .collect();
        // home_dir falls back to the passwd entry when HOME is unset, as Node's os.homedir() does.
        Env::from_vars(&vars, std::env::home_dir().as_deref())
    }

    /// Parse the variables in `vars` with `home` as the home directory. The config path is
    /// checked before tips, as the TypeScript server checks it first.
    pub fn from_vars(vars: &HashMap<String, String>, home: Option<&Path>) -> Result<Env, ConfigError> {
        Ok(Env {
            config_path: config_path(vars.get(CONFIG_PATH_ENV).map(String::as_str), home)?,
            tips: tips(vars.get(TIPS_ENV).map(String::as_str))?,
        })
    }
}

/// `LOGSEQ_MCP_CONFIG` when set (it must be absolute), else `~/.logseq-mcp/config.json`. An
/// empty or blank variable is ignored. The error echoes the value, as `resolveConfigPath` does:
/// it's a path the user set, with no secret in it.
fn config_path(raw: Option<&str>, home: Option<&Path>) -> Result<ConfigPath, ConfigError> {
    let raw = raw.unwrap_or_default();
    let path = js_trim(raw);
    if path.is_empty() {
        return match home {
            Some(home) if home.is_absolute() => Ok(ConfigPath(home.join(".logseq-mcp").join("config.json"))),
            _ => Err(ConfigError::Validation {
                field: CONFIG_PATH_ENV.to_owned(),
                problem: "must be set to an absolute path, as there is no home directory to find ~/.logseq-mcp/config.json in"
                    .to_owned(),
            }),
        };
    }
    if !Path::new(path).is_absolute() {
        return Err(ConfigError::Validation {
            field: CONFIG_PATH_ENV.to_owned(),
            problem: format!("must be an absolute path (got \"{raw}\")"),
        });
    }
    Ok(ConfigPath(PathBuf::from(path)))
}

/// `LOGSEQ_MCP_TIPS`, case-insensitive with surrounding whitespace ignored (as `trim()` does). Any other value is an
/// error, so a typo such as `disabled` can't leave tips on silently. The message echoes the
/// value, which holds no secret, as in TypeScript.
fn tips(raw: Option<&str>) -> Result<TipsOverride, ConfigError> {
    let Some(raw) = raw else { return Ok(TipsOverride::Unset) };
    let flag = js_trim(raw).to_lowercase();
    if flag.is_empty() {
        Ok(TipsOverride::Unset)
    } else if TIPS_OFF_VALUES.contains(&flag.as_str()) {
        Ok(TipsOverride::Off)
    } else if TIPS_ON_VALUES.contains(&flag.as_str()) {
        Ok(TipsOverride::On)
    } else {
        Err(ConfigError::Validation {
            field: TIPS_ENV.to_owned(),
            problem: format!("must be one of {} (got \"{raw}\")", [TIPS_ON_VALUES, TIPS_OFF_VALUES].concat().join(", ")),
        })
    }
}

/// `String.prototype.trim()`: JavaScript's whitespace and line terminators. That is Rust's
/// `White_Space` plus U+FEFF (a byte-order mark), less U+0085, which JavaScript keeps.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> Option<&'static Path> {
        Some(Path::new("/home/alice"))
    }

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn env(pairs: &[(&str, &str)], home: Option<&Path>) -> Result<Env, ConfigError> {
        Env::from_vars(&vars(pairs), home)
    }

    fn message(result: Result<Env, ConfigError>) -> String {
        match result {
            Err(error @ ConfigError::Validation { .. }) => error.to_string(),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn unset_with_a_home_directory_is_the_default_path() {
        let env = env(&[], home()).unwrap();
        assert_eq!(env.config_path.as_path(), Path::new("/home/alice/.logseq-mcp/config.json"));
        assert_eq!(env.tips, TipsOverride::Unset);
        for blank in ["", "   "] {
            let env = Env::from_vars(&vars(&[(CONFIG_PATH_ENV, blank)]), home()).unwrap();
            assert_eq!(env.config_path.as_path(), Path::new("/home/alice/.logseq-mcp/config.json"));
        }
    }

    #[test]
    fn an_absolute_path_is_used_trimmed() {
        let env = env(&[(CONFIG_PATH_ENV, " /tmp/instance/config.json ")], None).unwrap();
        assert_eq!(env.config_path.as_path(), Path::new("/tmp/instance/config.json"));
    }

    #[test]
    fn a_relative_path_is_refused() {
        assert_eq!(
            message(env(&[(CONFIG_PATH_ENV, "relative/config.json")], home())),
            "Configuration validation failed: LOGSEQ_MCP_CONFIG must be an absolute path (got \"relative/config.json\")"
        );
    }

    #[test]
    fn unset_without_a_home_directory_is_refused() {
        for home in [None, Some(Path::new("")), Some(Path::new("relative"))] {
            let text = message(env(&[], home));
            assert!(text.starts_with("Configuration validation failed: LOGSEQ_MCP_CONFIG must be set"), "{home:?}: {text}");
        }
    }

    #[test]
    fn tips_accepts_the_typescript_values() {
        for (value, expected) in [
            ("on", TipsOverride::On),
            (" TRUE ", TipsOverride::On),
            ("1", TipsOverride::On),
            ("Yes", TipsOverride::On),
            ("off", TipsOverride::Off),
            ("False", TipsOverride::Off),
            ("0", TipsOverride::Off),
            ("no", TipsOverride::Off),
            ("", TipsOverride::Unset),
            ("  ", TipsOverride::Unset),
        ] {
            assert_eq!(env(&[(TIPS_ENV, value)], home()).unwrap().tips, expected, "{value:?}");
        }
    }

    #[test]
    fn values_are_trimmed_as_javascript_trims() {
        assert_eq!(js_trim("\u{feff} on \u{a0}\u{2028}\t"), "on");
        assert_eq!(js_trim("\u{85}on\u{85}"), "\u{85}on\u{85}");
        assert_eq!(env(&[(TIPS_ENV, "\u{feff}off")], home()).unwrap().tips, TipsOverride::Off);
        assert_eq!(env(&[(TIPS_ENV, "\u{feff}")], home()).unwrap().tips, TipsOverride::Unset);
        let env = env(&[(CONFIG_PATH_ENV, "\u{feff}/tmp/instance/config.json")], None).unwrap();
        assert_eq!(env.config_path.as_path(), Path::new("/tmp/instance/config.json"));
    }

    #[test]
    fn a_bad_tips_value_is_refused_and_echoed() {
        assert_eq!(
            message(env(&[(TIPS_ENV, "disabled")], home())),
            "Configuration validation failed: LOGSEQ_MCP_TIPS must be one of 1, true, on, yes, 0, false, off, no (got \"disabled\")"
        );
    }

    #[test]
    fn the_config_path_is_checked_before_tips() {
        let text = message(env(&[(CONFIG_PATH_ENV, "relative"), (TIPS_ENV, "disabled")], home()));
        assert!(text.contains("LOGSEQ_MCP_CONFIG"), "{text}");
    }

    #[test]
    fn the_variable_wins_over_the_config_file() {
        assert!(TipsOverride::Unset.tips_enabled(None));
        assert!(TipsOverride::Unset.tips_enabled(Some(true)));
        assert!(!TipsOverride::Unset.tips_enabled(Some(false)));
        assert!(TipsOverride::On.tips_enabled(Some(false)));
        assert!(!TipsOverride::Off.tips_enabled(Some(true)));
    }
}
