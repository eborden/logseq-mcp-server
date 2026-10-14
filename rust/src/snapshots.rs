//! The snapshot cache (ADR-0038): the first call that cuts a list keeps the whole list here, so a later page of it is
//! read from memory and costs no LogSeq call, and is consistent with the pages before it.
//!
//! It is a cache, not progress. A token (`crate::cursor`) carries everything the next page needs, so a page whose
//! snapshot is gone is built again with the calls the first page made, and the tool is correct without this
//! file, only slower. Nothing in it is written back to LogSeq, and nothing waits on it.
//!
//! A snapshot is served only while it is young, and only to a call that asks for it with the arguments it was built
//! from. The server owns one [`Snapshots`] (`crate::server`) and passes it to the tools, like the clock. Its lock is
//! never held across an `await`: every method here is plain code.

use std::any::Any;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::cursor::SnapshotKey;

/// Most snapshots held at once.
///
/// These four limits are the starting values of ADR-0038 (ADR-0011 treats caps as tuning, so they are changed
/// here and the ADR is not updated). A snapshot lives a minute, a model reads a few lists at a time, and the list of
/// one tool call is at most a few thousand entries, so the count and the bytes are ceilings and not targets.
pub const MAX_SNAPSHOTS: usize = 16;

/// Most bytes all the snapshots hold together (32 MiB), as the tools declare them.
pub const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

/// Most bytes one snapshot holds (8 MiB). A larger list is not kept: the page that would have used it is served by
/// the miss path, which is the same result with the first page's calls.
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

/// How long a snapshot is served, from the moment it was made. Reading a page does not extend it (maintainer,
/// 2026-10-14: "Let's go with 1 minute"): a longer read re-reads LogSeq with the first page's calls, so a snapshot
/// shows LogSeq as it was at most a minute ago.
pub const MAX_AGE: Duration = Duration::from_secs(60);

/// The bounds of a [`Snapshots`]. The server uses [`Limits::STARTING`]; a test builds a smaller one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub count: usize,
    pub total_bytes: usize,
    pub snapshot_bytes: usize,
    pub max_age: Duration,
}

impl Limits {
    pub const STARTING: Limits = Limits { count: MAX_SNAPSHOTS, total_bytes: MAX_TOTAL_BYTES, snapshot_bytes: MAX_SNAPSHOT_BYTES, max_age: MAX_AGE };
}

/// One list a tool kept.
struct Entry {
    n: u64,
    /// The arguments the list was built from, in the form a token carries them
    args: Map<String, Value>,
    /// What the tool said the list weighs
    bytes: usize,
    created: Instant,
    /// When it was last served, as a count of uses, for least-recently-used eviction
    used: u64,
    list: Arc<dyn Any + Send + Sync>,
}

#[derive(Default)]
struct Inner {
    /// The counter of the keys handed out
    issued: u64,
    /// The counter of uses
    uses: u64,
    total_bytes: usize,
    entries: Vec<Entry>,
}

impl Inner {
    fn remove(&mut self, at: usize) {
        let gone = self.entries.swap_remove(at);
        self.total_bytes -= gone.bytes;
    }

    /// Drop every snapshot that is older than `max_age`.
    fn expire(&mut self, now: Instant, max_age: Duration) {
        let mut at = 0;
        while at < self.entries.len() {
            if now.saturating_duration_since(self.entries[at].created) >= max_age {
                self.remove(at);
            } else {
                at += 1;
            }
        }
    }

    /// Drop the least recently used snapshot, if there is one.
    fn evict_least_recent(&mut self) {
        if let Some(at) = self.entries.iter().enumerate().min_by_key(|(_, entry)| entry.used).map(|(at, _)| at) {
            self.remove(at);
        }
    }
}

/// The cache. One per server process.
pub struct Snapshots {
    /// When the server started, in milliseconds since 1970: half of every key, so a restarted server can't mistake a
    /// counter it hands out again for one a client still holds
    started: u64,
    limits: Limits,
    inner: Mutex<Inner>,
}

impl Snapshots {
    /// A cache with the starting limits, for a server that started at `started_ms` (milliseconds since 1970).
    pub fn new(started_ms: u64) -> Snapshots {
        Snapshots::with_limits(started_ms, Limits::STARTING)
    }

    pub fn with_limits(started_ms: u64, limits: Limits) -> Snapshots {
        Snapshots { started: started_ms, limits, inner: Mutex::new(Inner::default()) }
    }

    /// A poisoned lock means another call panicked while it held it; the cache holds only lists that can be rebuilt,
    /// so its contents are as good as ever.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The key of a list about to be kept. It is reserved before the list is stored, since the token that names it is
    /// part of the page being measured against the budget, and a key is never reused.
    pub fn reserve(&self) -> SnapshotKey {
        let mut inner = self.lock();
        inner.issued += 1;
        SnapshotKey { started: self.started, n: inner.issued }
    }

    /// Keep `list` under `key`, built from `args`, weighing `bytes`. Returns whether it was kept: a list over the
    /// per-snapshot limit is not, and the page that would have used it is built again instead. Older snapshots go to
    /// make room, the least recently used first.
    pub fn insert<T: Any + Send + Sync>(&self, key: SnapshotKey, args: &Map<String, Value>, bytes: usize, list: Arc<T>, now: Instant) -> bool {
        if key.started != self.started || bytes > self.limits.snapshot_bytes || bytes > self.limits.total_bytes || self.limits.count == 0 {
            return false;
        }
        let mut inner = self.lock();
        inner.expire(now, self.limits.max_age);
        while !inner.entries.is_empty() && (inner.entries.len() >= self.limits.count || inner.total_bytes + bytes > self.limits.total_bytes) {
            inner.evict_least_recent();
        }
        inner.uses += 1;
        let used = inner.uses;
        inner.total_bytes += bytes;
        inner.entries.push(Entry { n: key.n, args: args.clone(), bytes, created: now, used, list });
        true
    }

    /// The list kept under `key`, if it is still there, younger than the limit, was built from exactly `args` and is
    /// a `T`. Anything else is a miss, and the tool builds the list again. An old snapshot is dropped when it is asked
    /// for. Serving one makes it the most recently used, and does not extend its life.
    pub fn get<T: Any + Send + Sync>(&self, key: &SnapshotKey, args: &Map<String, Value>, now: Instant) -> Option<Arc<T>> {
        if key.started != self.started {
            return None;
        }
        let mut inner = self.lock();
        let at = inner.entries.iter().position(|entry| entry.n == key.n)?;
        if now.saturating_duration_since(inner.entries[at].created) >= self.limits.max_age {
            inner.remove(at);
            return None;
        }
        if inner.entries[at].args != *args {
            return None;
        }
        let list = Arc::clone(&inner.entries[at].list).downcast::<T>().ok()?;
        inner.uses += 1;
        let used = inner.uses;
        inner.entries[at].used = used;
        Some(list)
    }

    /// How many snapshots are held (including any that have aged out and not been dropped yet).
    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The bytes the snapshots held declare, in all.
    pub fn total_bytes(&self) -> usize {
        self.lock().total_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STARTED: u64 = 1_760_000_000_000;

    fn args(text: &str) -> Map<String, Value> {
        json!({"text": text}).as_object().cloned().unwrap()
    }

    fn small(count: usize, total_bytes: usize, snapshot_bytes: usize) -> Snapshots {
        Snapshots::with_limits(STARTED, Limits { count, total_bytes, snapshot_bytes, max_age: Duration::from_secs(60) })
    }

    /// Keep a list of one number under a new key, `bytes` heavy.
    fn keep(snapshots: &Snapshots, text: &str, bytes: usize, now: Instant) -> SnapshotKey {
        let key = snapshots.reserve();
        snapshots.insert(key, &args(text), bytes, Arc::new(vec![bytes]), now);
        key
    }

    fn served(snapshots: &Snapshots, key: &SnapshotKey, text: &str, now: Instant) -> Option<Vec<usize>> {
        snapshots.get::<Vec<usize>>(key, &args(text), now).map(|list| (*list).clone())
    }

    #[test]
    fn the_starting_values_are_the_adrs() {
        assert_eq!((MAX_SNAPSHOTS, MAX_TOTAL_BYTES, MAX_SNAPSHOT_BYTES, MAX_AGE), (16, 32 << 20, 8 << 20, Duration::from_secs(60)));
        assert_eq!(Limits::STARTING, Limits { count: 16, total_bytes: 32 << 20, snapshot_bytes: 8 << 20, max_age: Duration::from_secs(60) });
    }

    #[test]
    fn a_kept_list_is_served_to_the_arguments_it_was_built_from_and_to_no_others() {
        let (snapshots, now) = (Snapshots::new(STARTED), Instant::now());
        let key = keep(&snapshots, "importer", 100, now);
        assert_eq!(served(&snapshots, &key, "importer", now), Some(vec![100]));
        assert_eq!(served(&snapshots, &key, "another", now), None, "other arguments never read this list");
        assert_eq!(served(&snapshots, &key, "importer", now), Some(vec![100]), "a refused read leaves it in place");
        // a list of another type is no hit
        assert!(snapshots.get::<String>(&key, &args("importer"), now).is_none());
    }

    #[test]
    fn keys_are_unique_and_a_key_of_another_process_is_a_miss() {
        let (snapshots, now) = (Snapshots::new(STARTED), Instant::now());
        let (first, second) = (snapshots.reserve(), snapshots.reserve());
        assert_ne!(first, second);
        assert_eq!((first.started, second.started), (STARTED, STARTED));
        let key = keep(&snapshots, "importer", 10, now);
        let restarted = Snapshots::new(STARTED + 1);
        let foreign = restarted.reserve();
        assert_eq!(foreign.n, 1);
        assert_eq!(served(&snapshots, &SnapshotKey { started: STARTED + 1, n: key.n }, "importer", now), None);
        // nor can it be stored: the key says another process made it
        assert!(!snapshots.insert(foreign, &args("x"), 1, Arc::new(0u8), now));
    }

    #[test]
    fn a_snapshot_is_served_for_a_minute_from_its_making_and_reading_does_not_extend_it() {
        let (snapshots, start) = (Snapshots::new(STARTED), Instant::now());
        let key = keep(&snapshots, "importer", 100, start);
        assert!(served(&snapshots, &key, "importer", start + Duration::from_secs(59)).is_some());
        // read at 59 s: still gone at 60 s, as if it had not been read
        assert!(served(&snapshots, &key, "importer", start + Duration::from_secs(60)).is_none());
        assert_eq!(snapshots.len(), 0, "an old snapshot is dropped when it is asked for");
        assert_eq!(snapshots.total_bytes(), 0);
    }

    #[test]
    fn an_insert_drops_the_snapshots_that_have_aged_out() {
        let (snapshots, start) = (Snapshots::new(STARTED), Instant::now());
        keep(&snapshots, "old", 100, start);
        let later = start + Duration::from_secs(61);
        let fresh = keep(&snapshots, "new", 50, later);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots.total_bytes(), 50);
        assert!(served(&snapshots, &fresh, "new", later).is_some());
    }

    #[test]
    fn the_least_recently_used_snapshot_goes_first_when_the_count_is_over() {
        let (snapshots, now) = (small(2, 1000, 1000), Instant::now());
        let (a, b) = (keep(&snapshots, "a", 10, now), keep(&snapshots, "b", 10, now));
        // reading `a` makes `b` the least recent
        assert!(served(&snapshots, &a, "a", now).is_some());
        let c = keep(&snapshots, "c", 10, now);
        assert_eq!(snapshots.len(), 2);
        assert!(served(&snapshots, &a, "a", now).is_some());
        assert!(served(&snapshots, &b, "b", now).is_none(), "b was the least recently used");
        assert!(served(&snapshots, &c, "c", now).is_some());
    }

    #[test]
    fn the_total_bytes_are_kept_under_the_limit_by_dropping_the_least_recent() {
        let (snapshots, now) = (small(16, 100, 100), Instant::now());
        let a = keep(&snapshots, "a", 60, now);
        let b = keep(&snapshots, "b", 30, now);
        assert_eq!((snapshots.len(), snapshots.total_bytes()), (2, 90));
        // 50 more would make 140: `a`, the older, goes, and 80 are held
        let c = keep(&snapshots, "c", 50, now);
        assert_eq!((snapshots.len(), snapshots.total_bytes()), (2, 80));
        assert!(served(&snapshots, &a, "a", now).is_none());
        assert!(served(&snapshots, &b, "b", now).is_some());
        assert!(served(&snapshots, &c, "c", now).is_some());
        // exactly at the limit is kept
        let d = keep(&snapshots, "d", 20, now);
        assert!(served(&snapshots, &d, "d", now).is_some());
        assert!(snapshots.total_bytes() <= 100);
    }

    #[test]
    fn a_list_over_the_per_snapshot_limit_is_not_kept_and_costs_the_others_nothing() {
        let (snapshots, now) = (small(16, 1000, 100), Instant::now());
        let kept = keep(&snapshots, "kept", 100, now);
        let key = snapshots.reserve();
        assert!(!snapshots.insert(key, &args("big"), 101, Arc::new(vec![101usize]), now));
        assert_eq!(served(&snapshots, &key, "big", now), None);
        assert!(served(&snapshots, &kept, "kept", now).is_some(), "an oversized list evicts nothing");
        assert_eq!(snapshots.len(), 1);
        // a list over the total limit is not kept either, even if the per-snapshot limit would allow it
        let tight = small(16, 50, 100);
        assert!(!tight.insert(tight.reserve(), &args("x"), 60, Arc::new(0u8), now));
    }

    #[test]
    fn a_cache_that_holds_nothing_keeps_nothing() {
        let (none, now) = (small(0, 1000, 1000), Instant::now());
        assert!(!none.insert(none.reserve(), &args("x"), 1, Arc::new(0u8), now));
        assert!(none.is_empty());
    }

    #[test]
    fn the_standard_limits_hold_sixteen_snapshots() {
        let (snapshots, now) = (Snapshots::new(STARTED), Instant::now());
        let keys: Vec<SnapshotKey> = (0..20).map(|n| keep(&snapshots, &n.to_string(), 10, now)).collect();
        assert_eq!(snapshots.len(), MAX_SNAPSHOTS);
        assert!(served(&snapshots, &keys[0], "0", now).is_none());
        assert!(served(&snapshots, &keys[19], "19", now).is_some());
    }
}
