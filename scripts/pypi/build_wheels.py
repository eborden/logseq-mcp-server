#!/usr/bin/env python3
"""Build the PyPI wheels of logseq-mcp-server from the binaries of one release set (ADR-0036).

Run as `python3 -I scripts/pypi/build_wheels.py --version X.Y.Z --assets DIR --readme FILE --out DIR`.

DIR holds the release set that release.yml assembles (ADR-0035): one bare executable per target named
`logseq-mcp-server-<version>-<target>`, plus SHA256SUMS, LICENSE and THIRD-PARTY-NOTICES.txt. Each binary becomes one
platform wheel. The wheel carries the very bytes the release gate tested, and puts them in the wheel's `scripts` data
directory, so an installer (pip, uv, uvx) puts the executable on PATH and nothing runs in Python.

Nothing is built unless every input checks out: the version is plain x.y.z, every file is a regular file listed in
SHA256SUMS with a matching hash (the bytes hashed are the bytes shipped), and every binary is for the CPU and operating
system its wheel tag claims and, on macOS, needs no newer macOS than the tag allows. A build that fails leaves no wheel
behind. This script only reads the assets and writes wheels. It contacts nothing and publishes nothing.

Standard library only, so the release job needs no install step (ADR-0036).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import re
import struct
import sys
import zipfile
from pathlib import Path

NAME = "logseq-mcp-server"
DIST = "logseq_mcp_server"  # the name as a wheel file and .dist-info directory spell it (PEP 427)
HOMEPAGE = "https://github.com/eborden/logseq-mcp-server"
SUMMARY = "Read-only MCP server for LogSeq graphs: batched Datalog queries, bounded results, one native binary."
REQUIRES_PYTHON = ">=3.9"
LICENSE_FILES = ("LICENSE", "THIRD-PARTY-NOTICES.txt")
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")

# A fixed timestamp, so building twice from the same assets gives the same bytes. A wheel's own date means nothing.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)

MACHO_MAGIC = b"\xcf\xfa\xed\xfe"  # 64-bit Mach-O, little endian
MACHO_HEADER_SIZE = 32
MACHO_MAX_LOAD_COMMANDS = 1 << 20  # a real binary's are a few KiB; a larger claim is a malformed file
MACHO_CPU_ARM64 = 0x0100000C
MACHO_CPU_X86_64 = 0x01000007
MH_EXECUTE = 2
LC_VERSION_MIN_MACOSX = 0x24
LC_BUILD_VERSION = 0x32
PLATFORM_MACOS = 1
ELF_MAGIC = b"\x7fELF"
ELF_MACHINE_X86_64 = 0x3E
ET_EXEC = 2
ET_DYN = 3  # a static-pie executable is ET_DYN
ELF_OSABI_ALLOWED = (0, 3)  # System V, GNU

# target triple -> (the wheel's platform tags, the binary's kind, the oldest macOS the tags promise). The platform tags
# are what pip and uv match against the machine. The musl binary is static, so it runs on glibc and musl alike and takes
# both Linux tags (ADR-0036). The macOS minimum is the number in the tag, and a binary that needs a newer macOS is refused.
TARGETS = {
    "aarch64-apple-darwin": (("macosx_11_0_arm64",), "macho-arm64", (11, 0)),
    "x86_64-apple-darwin": (("macosx_10_12_x86_64",), "macho-x86_64", (10, 12)),
    "x86_64-unknown-linux-musl": (("manylinux_2_17_x86_64", "musllinux_1_2_x86_64"), "elf-x86_64", None),
}


class BuildError(Exception):
    """An input that does not check out. The message says which, and no wheel is left behind."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_sums(path: Path) -> dict[str, str]:
    """SHA256SUMS in `sha256sum` format: a hash, two spaces (or a space and a star), a file name."""
    if path.is_symlink() or not path.is_file():
        raise BuildError(f"{path.name} is missing from the assets")
    sums: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64}) [ *]([^/\\\s][^/\\]*)", line)
        if not match:
            raise BuildError(f"{path.name} line {number} is not a sha256sum line")
        digest, name = match.groups()
        if name in sums:
            raise BuildError(f"{path.name} lists {name} twice")
        sums[name] = digest
    return sums


def verified(assets: Path, sums: dict[str, str], name: str) -> bytes:
    """The asset's bytes, once it is a regular file that SHA256SUMS lists with the hash of exactly these bytes.

    The bytes are read once and hashed from memory, so what is checked is what ships. A symlink is refused: it could
    point out of the directory, or change between the check and the read."""
    path = assets / name
    if path.is_symlink():
        raise BuildError(f"{name} is a symbolic link, and an asset must be a regular file")
    if not path.is_file():
        raise BuildError(f"{name} is missing from the assets")
    if name not in sums:
        raise BuildError(f"{name} is not listed in SHA256SUMS")
    data = path.read_bytes()
    actual = sha256_bytes(data)
    if actual != sums[name]:
        raise BuildError(f"{name} does not match SHA256SUMS (listed {sums[name]}, found {actual})")
    return data


def macos_minimum(data: bytes, name: str) -> tuple[int, int]:
    """The oldest macOS this Mach-O binary runs on, from its LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX command."""
    count, size = struct.unpack("<II", data[16:24])
    if size > MACHO_MAX_LOAD_COMMANDS or MACHO_HEADER_SIZE + size > len(data):
        raise BuildError(f"{name} has load commands that run past the end of the file")
    offset, end = MACHO_HEADER_SIZE, MACHO_HEADER_SIZE + size
    for _ in range(count):
        if offset + 8 > end:
            raise BuildError(f"{name} has a truncated load command list")
        command, command_size = struct.unpack("<II", data[offset : offset + 8])
        if command_size < 8 or command_size % 4 or offset + command_size > end:
            raise BuildError(f"{name} has a malformed load command")
        if command == LC_BUILD_VERSION and command_size >= 16:
            platform, minos = struct.unpack("<II", data[offset + 8 : offset + 16])
            if platform == PLATFORM_MACOS:
                return (minos >> 16, (minos >> 8) & 0xFF)
        if command == LC_VERSION_MIN_MACOSX and command_size >= 16:
            (version,) = struct.unpack("<I", data[offset + 8 : offset + 12])
            return (version >> 16, (version >> 8) & 0xFF)
        offset += command_size
    raise BuildError(f"{name} does not say which macOS it needs, so its wheel tag can't be checked")


def check_binary(data: bytes, name: str, kind: str, target: str, minimum_macos: tuple[int, int] | None) -> None:
    """The binary is for the CPU and operating system its wheel is tagged for, so a mislabeled asset can't ship."""
    if kind.startswith("macho"):
        wanted = MACHO_CPU_ARM64 if kind == "macho-arm64" else MACHO_CPU_X86_64
        label = f"a 64-bit {kind.removeprefix('macho-')} Mach-O executable"
        if len(data) < MACHO_HEADER_SIZE or data[:4] != MACHO_MAGIC:
            raise BuildError(f"{name} is not {label}, which {target} needs")
        cpu, filetype = struct.unpack("<I4xI", data[4:16])
        if cpu != wanted or filetype != MH_EXECUTE:
            raise BuildError(f"{name} is not {label}, which {target} needs")
        found = macos_minimum(data, name)
        if minimum_macos is not None and found > minimum_macos:
            raise BuildError(
                f"{name} needs macOS {found[0]}.{found[1]}, newer than the {minimum_macos[0]}.{minimum_macos[1]} its wheel tag promises. "
                "Raise the tag in TARGETS first."
            )
        return
    label = "a 64-bit x86_64 ELF executable"
    if len(data) < 20 or data[:4] != ELF_MAGIC or data[4] != 2 or data[5] != 1:
        raise BuildError(f"{name} is not {label}, which {target} needs")
    (kind_of_file, machine) = struct.unpack("<HH", data[16:20])
    if kind_of_file not in (ET_EXEC, ET_DYN) or machine != ELF_MACHINE_X86_64 or data[7] not in ELF_OSABI_ALLOWED:
        raise BuildError(f"{name} is not {label}, which {target} needs")


def record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")


def metadata(version: str, readme: str) -> str:
    # Metadata 2.4 carries License-Expression and License-File (PEP 639). The body after the blank line is the long description.
    headers = [
        "Metadata-Version: 2.4",
        f"Name: {NAME}",
        f"Version: {version}",
        f"Summary: {SUMMARY}",
        "Keywords: logseq, mcp, model-context-protocol, knowledge-graph, rust",
        f"Project-URL: Homepage, {HOMEPAGE}",
        f"Project-URL: Source, {HOMEPAGE}",
        f"Project-URL: Issues, {HOMEPAGE}/issues",
        "License-Expression: MIT",
        *[f"License-File: {name}" for name in LICENSE_FILES],
        "Classifier: Development Status :: 5 - Production/Stable",
        "Classifier: Environment :: Console",
        "Classifier: Intended Audience :: Developers",
        "Classifier: Programming Language :: Rust",
        "Classifier: Topic :: Software Development :: Libraries",
        f"Requires-Python: {REQUIRES_PYTHON}",
        "Description-Content-Type: text/markdown",
    ]
    return "\n".join(headers) + "\n\n" + readme


def wheel_file(tags: tuple[str, ...]) -> str:
    lines = ["Wheel-Version: 1.0", "Generator: logseq-mcp-server scripts/pypi/build_wheels.py", "Root-Is-Purelib: false"]
    lines += [f"Tag: py3-none-{tag}" for tag in tags]
    return "\n".join(lines) + "\n"


def zip_entry(path: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, date_time=ZIP_DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3  # Unix, so the mode below is read as a mode
    info.external_attr = (0o100000 | mode) << 16
    return info


def build_wheel(version: str, tags: tuple[str, ...], binary: bytes, licenses: dict[str, bytes], readme: str, out: Path) -> Path:
    data_dir = f"{DIST}-{version}.data"
    info_dir = f"{DIST}-{version}.dist-info"
    # Every file but RECORD, in the order it is written: the executable is the only one with the executable bit.
    files: list[tuple[str, bytes, int]] = [
        (f"{data_dir}/scripts/{NAME}", binary, 0o755),
        (f"{info_dir}/METADATA", metadata(version, readme).encode("utf-8"), 0o644),
        (f"{info_dir}/WHEEL", wheel_file(tags).encode("utf-8"), 0o644),
    ]
    files += [(f"{info_dir}/licenses/{name}", data, 0o644) for name, data in licenses.items()]
    record = "".join(f"{path},{record_hash(data)},{len(data)}\n" for path, data, _ in files)
    record += f"{info_dir}/RECORD,,\n"
    files.append((f"{info_dir}/RECORD", record.encode("utf-8"), 0o644))

    wheel = out / f"{DIST}-{version}-py3-none-{'.'.join(tags)}.whl"
    partial = wheel.with_name(wheel.name + ".partial")
    with zipfile.ZipFile(partial, "w") as archive:
        for path, data, mode in files:
            archive.writestr(zip_entry(path, mode), data)
    partial.replace(wheel)  # a failed build never leaves a wheel that looks complete
    return wheel


def build(version: str, assets: Path, readme_path: Path, out: Path) -> list[Path]:
    if not VERSION_PATTERN.fullmatch(version):
        raise BuildError(f"the version must be plain x.y.z, got {version!r}")
    if not readme_path.is_file():
        raise BuildError(f"{readme_path} is missing")
    sums = read_sums(assets / "SHA256SUMS")
    licenses = {name: verified(assets, sums, name) for name in LICENSE_FILES}
    binaries = {}
    for target, (_, kind, minimum_macos) in TARGETS.items():
        name = f"{NAME}-{version}-{target}"
        data = verified(assets, sums, name)
        check_binary(data, name, kind, target, minimum_macos)
        binaries[target] = data
    readme = readme_path.read_text(encoding="utf-8")
    if out.exists():
        stale = sorted(p.name for p in [*out.glob("*.whl"), *out.glob("*.whl.partial")])
        if stale:
            raise BuildError(f"{out} already holds wheels ({', '.join(stale)}), so a stale one can't be uploaded with the new ones")
    out.mkdir(parents=True, exist_ok=True)
    built: list[Path] = []
    try:
        for target, (tags, _, _) in TARGETS.items():
            built.append(build_wheel(version, tags, binaries[target], licenses, readme, out))
    except BaseException:
        # No half a set: remove what this run wrote, including a file that was being written
        for path in [*built, *out.glob("*.whl.partial")]:
            path.unlink(missing_ok=True)
        raise
    return built


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", required=True, help="the release version, plain x.y.z")
    parser.add_argument("--assets", required=True, type=Path, help="the directory of release assets")
    parser.add_argument("--readme", required=True, type=Path, help="the long description (pypi/README.md)")
    parser.add_argument("--out", required=True, type=Path, help="where the wheels go (must hold no wheels yet)")
    args = parser.parse_args(argv)
    try:
        wheels = build(args.version, args.assets, args.readme, args.out)
    except BuildError as error:
        print(f"build_wheels: {error}", file=sys.stderr)
        return 1
    for wheel in wheels:
        print(f"{wheel.name}  sha256={sha256_file(wheel)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
