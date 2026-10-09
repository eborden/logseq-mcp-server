#!/bin/sh
# Starts the LogSeq MCP server (ADR-0035): finds the release binary for this platform and this checkout's version,
# downloads it from GitHub Releases on first use, checks it against SHA256SUMS, caches it and `exec`s it.
#
# The plugin runs this (`sh ${CLAUDE_PLUGIN_ROOT}/scripts/logseq-mcp-server.sh`), and a host without plugins can
# point its `command` at it. Needs `sh`, `uname`, `curl`, and `shasum` or `sha256sum`, plus the basic tools every
# macOS and Linux has (awk, sed, tr, mkdir, mv, rm, chmod). No Node.
#
# stdout is the MCP channel, so everything this script says goes to stderr and nothing to stdout (ADR-0004). It
# never prints a config value or a token (ADR-0003), and it never runs a file that was not checked.
#
# Environment:
#   LOGSEQ_MCP_BINARY            absolute path of a server binary to run as it is. Skips the download.
#   LOGSEQ_MCP_RELEASE_BASE_URL  where the release files are fetched from, instead of
#                                https://github.com/eborden/logseq-mcp-server/releases/download/v<version>
#                                (an https://, http:// or file:// base, no trailing slash). The checks still run.
#   XDG_CACHE_HOME               the cache's parent. Default: ~/Library/Caches on macOS, ~/.cache elsewhere.
#   HTTPS_PROXY, ALL_PROXY, NO_PROXY ... read by curl as usual.
#
# Release files, for version V and target T: logseq-mcp-server-V-T, SHA256SUMS, LICENSE, THIRD-PARTY-NOTICES.txt.

set -eu

NAME='logseq-mcp-server'
DEFAULT_BASE='https://github.com/eborden/logseq-mcp-server/releases/download'

say() {
  printf '%s: %s\n' "$NAME" "$*" >&2
}

manual_route() {
  say "To install by hand: download the binary for your platform and SHA256SUMS from the release page"
  say "(https://github.com/eborden/logseq-mcp-server/releases), check the binary against SHA256SUMS,"
  say "make it executable, and set LOGSEQ_MCP_BINARY to its absolute path."
}

die() {
  say "$*"
  manual_route
  exit 1
}

# A base URL as shown to the user: any user:password@ part is dropped so a credential is never printed.
shown() {
  printf '%s' "$1" | sed 's,//[^/@]*@,//,'
}

# ---------------------------------------------------------------------------------------------------------------
# The override that skips everything below.

if [ -n "${LOGSEQ_MCP_BINARY:-}" ]; then
  case $LOGSEQ_MCP_BINARY in
    /*) ;;
    *)
      say "LOGSEQ_MCP_BINARY must be an absolute path."
      exit 1
      ;;
  esac
  if [ ! -f "$LOGSEQ_MCP_BINARY" ] || [ ! -x "$LOGSEQ_MCP_BINARY" ]; then
    say "LOGSEQ_MCP_BINARY does not name an executable file."
    exit 1
  fi
  exec "$LOGSEQ_MCP_BINARY" "$@"
fi

# ---------------------------------------------------------------------------------------------------------------
# The version, from the checkout this script sits in (scripts/ is one level below the root). The launcher fetches
# exactly this version, never "latest", so launcher and binary cannot drift apart.

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
package_json=$here/../package.json
if [ ! -f "$package_json" ]; then
  die "cannot find package.json next to this script, so the version to fetch is unknown."
fi
version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$package_json" | sed -n '1p')
case $version in
  '' | *[!0-9A-Za-z.+-]*)
    die "cannot read a valid version from package.json."
    ;;
esac

# ---------------------------------------------------------------------------------------------------------------
# The platform.

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64 | Darwin/aarch64) target='aarch64-apple-darwin' ;;
  Darwin/x86_64) target='x86_64-apple-darwin' ;;
  Linux/x86_64 | Linux/amd64) target='x86_64-unknown-linux-musl' ;;
  MINGW* | MSYS* | CYGWIN* | Windows*)
    die "Windows has no release binary yet (it is deferred, see ADR-0035). Build the server from a clone with 'cd rust && cargo build --release --locked'."
    ;;
  *)
    die "there is no release binary for this platform ($os $arch). Supported: macOS (arm64, x86_64) and Linux x86_64."
    ;;
esac

asset=$NAME-$version-$target

# ---------------------------------------------------------------------------------------------------------------
# The cache: <cache dir>/logseq-mcp-server/<version>/. A file is moved in only after it was checked, so a binary
# that is there is a checked one.

if [ -n "${XDG_CACHE_HOME:-}" ]; then
  cache_root=$XDG_CACHE_HOME
elif [ -z "${HOME:-}" ]; then
  die "neither XDG_CACHE_HOME nor HOME is set, so there is nowhere to cache the binary."
elif [ "$os" = 'Darwin' ]; then
  cache_root=$HOME/Library/Caches
else
  cache_root=$HOME/.cache
fi
cache=$cache_root/$NAME/$version

if [ -f "$cache/$asset" ] && [ -x "$cache/$asset" ]; then
  exec "$cache/$asset" "$@"
fi

# ---------------------------------------------------------------------------------------------------------------
# Download and check.

if [ -n "${LOGSEQ_MCP_RELEASE_BASE_URL:-}" ]; then
  base=${LOGSEQ_MCP_RELEASE_BASE_URL%/}
  case $base in
    https://* | http://* | file://*) ;;
    *)
      die "LOGSEQ_MCP_RELEASE_BASE_URL must start with https://, http:// or file://."
      ;;
  esac
  override=1
else
  base=$DEFAULT_BASE/v$version
  override=0
fi

if ! command -v curl >/dev/null 2>&1; then
  die "curl is not installed, and it is needed to download the server."
fi
if command -v shasum >/dev/null 2>&1; then
  hasher=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  hasher=sha256sum
else
  die "neither shasum nor sha256sum is installed, and one is needed to check the download."
fi

sha256_of() {
  if [ "$hasher" = shasum ]; then
    shasum -a 256 "$1" </dev/null | awk '{ print $1 }'
  else
    sha256sum "$1" </dev/null | awk '{ print $1 }'
  fi
}

stage=
cleanup() {
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! mkdir -p "$cache" 2>/dev/null; then
  die "cannot create the cache directory $cache (is it read-only?). Set XDG_CACHE_HOME to a writable directory."
fi
stage=$cache/.partial.$$
rm -rf "$stage"
if ! mkdir "$stage" 2>/dev/null; then
  die "cannot write to the cache directory $cache (is it read-only?). Set XDG_CACHE_HOME to a writable directory."
fi

# fetch <file name>: saves <base>/<file name> as $stage/<file name>.
fetch() {
  if [ "$override" = 1 ]; then
    protocols='=https,http,file'
  else
    protocols='=https'
  fi
  curl_status=0
  curl --fail --silent --location --connect-timeout 20 --max-time 300 \
    --proto "$protocols" --proto-redir "$protocols" \
    --output "$stage/$1" "$base/$1" </dev/null 2>/dev/null || curl_status=$?
  case $curl_status in
    0) return 0 ;;
    22 | 37 | 78)
      die "the release has no file named $1 at $(shown "$base") (version $version). The release may not be published yet, or it has no file for this platform."
      ;;
    5 | 6 | 7 | 28 | 35 | 52 | 55 | 56 | 60)
      die "could not download $1 from $(shown "$base") (curl exit $curl_status). Check the network connection; a proxy is read from HTTPS_PROXY, ALL_PROXY and NO_PROXY."
      ;;
    *)
      die "could not download $1 from $(shown "$base") (curl exit $curl_status)."
      ;;
  esac
}

# verify <file name>: the file in $stage must hash to what SHA256SUMS lists for its name.
verify() {
  expected=$(awk -v n="$1" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }' "$stage/SHA256SUMS")
  if [ -z "$expected" ]; then
    die "SHA256SUMS has no line for $1, so it cannot be checked. Nothing was installed."
  fi
  actual=$(sha256_of "$stage/$1" | tr 'A-F' 'a-f')
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $1: it does not match SHA256SUMS. Nothing was installed."
  fi
}

fetch SHA256SUMS
fetch "$asset"
fetch LICENSE
fetch THIRD-PARTY-NOTICES.txt
verify "$asset"
verify LICENSE
verify THIRD-PARTY-NOTICES.txt

if ! chmod 755 "$stage/$asset"; then
  die "cannot make the downloaded binary executable."
fi
# The binary moves last, so a binary in the cache means the other files are there too. Each mv is an atomic
# rename inside one directory, so a concurrent start sees a whole file or none.
mv -f "$stage/SHA256SUMS" "$cache/SHA256SUMS"
mv -f "$stage/LICENSE" "$cache/LICENSE"
mv -f "$stage/THIRD-PARTY-NOTICES.txt" "$cache/THIRD-PARTY-NOTICES.txt"
mv -f "$stage/$asset" "$cache/$asset"

cleanup
stage=
trap - EXIT HUP INT TERM
exec "$cache/$asset" "$@"
