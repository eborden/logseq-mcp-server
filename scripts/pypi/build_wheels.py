#!/usr/bin/env python3
"""Build the PyPI wheels of logseq-mcp-server from the binaries of a GitHub Release (ADR-0036).

Run as `python3 -I scripts/pypi/build_wheels.py --version X.Y.Z --assets DIR --readme FILE --out DIR`.

DIR holds the release set that release.yml writes (ADR-0035): one bare executable per target named
`logseq-mcp-server-<version>-<target>`, plus SHA256SUMS, LICENSE and THIRD-PARTY-NOTICES.txt. Each binary becomes one
platform wheel. The wheel carries the very bytes the release gate tested and attested, and puts them in the wheel's
`scripts` data directory, so an installer (pip, uv, uvx) puts the executable on PATH and nothing runs in Python.

Nothing is built unless every input checks out: the version is plain x.y.z, every file is listed in SHA256SUMS with a
matching hash, and every binary is for the CPU and operating system its wheel tag claims. This script only reads the
assets and writes wheels. It contacts nothing and publishes nothing.

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
MACHO_CPU_ARM64 = 0x0100000C
MACHO_CPU_X86_64 = 0x01000007
ELF_MAGIC = b"\x7fELF"
ELF_MACHINE_X86_64 = 0x3E

# target triple -> (the wheel's platform tags, the binary's kind). The platform tags are what pip and uv match against
# the machine. The musl binary is static, so it runs on glibc and musl alike and takes both Linux tags (ADR-0036).
TARGETS = {
    "aarch64-apple-darwin": (("macosx_11_0_arm64",), "macho-arm64"),
    "x86_64-apple-darwin": (("macosx_10_12_x86_64",), "macho-x86_64"),
    "x86_64-unknown-linux-musl": (("manylinux_2_17_x86_64", "musllinux_1_2_x86_64"), "elf-x86_64"),
}


class BuildError(Exception):
    """An input that does not check out. The message says which, and nothing is written."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_sums(path: Path) -> dict[str, str]:
    """SHA256SUMS in `sha256sum` format: a hash, two spaces (or a space and a star), a file name."""
    if not path.is_file():
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


def verified(assets: Path, sums: dict[str, str], name: str) -> Path:
    """The asset, once it is present and its hash is the one SHA256SUMS lists. Never a file SHA256SUMS does not list."""
    path = assets / name
    if not path.is_file():
        raise BuildError(f"{name} is missing from the assets")
    if name not in sums:
        raise BuildError(f"{name} is not listed in SHA256SUMS")
    actual = sha256_file(path)
    if actual != sums[name]:
        raise BuildError(f"{name} does not match SHA256SUMS (listed {sums[name]}, found {actual})")
    return path


def check_binary(path: Path, kind: str, target: str) -> None:
    """The binary is for the CPU and operating system its wheel is tagged for, so a mislabeled asset can't ship."""
    with path.open("rb") as handle:
        header = handle.read(32)
    if kind.startswith("macho"):
        wanted = MACHO_CPU_ARM64 if kind == "macho-arm64" else MACHO_CPU_X86_64
        if header[:4] != MACHO_MAGIC or len(header) < 8 or struct.unpack("<I", header[4:8])[0] != wanted:
            raise BuildError(f"{path.name} is not a 64-bit {kind.removeprefix('macho-')} Mach-O binary, which {target} needs")
        return
    is_elf64_le = header[:4] == ELF_MAGIC and len(header) >= 20 and header[4] == 2 and header[5] == 1
    if not is_elf64_le or struct.unpack("<H", header[18:20])[0] != ELF_MACHINE_X86_64:
        raise BuildError(f"{path.name} is not a 64-bit x86_64 ELF binary, which {target} needs")


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


def build_wheel(version: str, tags: tuple[str, ...], binary: Path, licenses: dict[str, Path], readme: str, out: Path) -> Path:
    data_dir = f"{DIST}-{version}.data"
    info_dir = f"{DIST}-{version}.dist-info"
    # Every file but RECORD, in the order it is written: the executable is the only one with the executable bit.
    files: list[tuple[str, bytes, int]] = [
        (f"{data_dir}/scripts/{NAME}", binary.read_bytes(), 0o755),
        (f"{info_dir}/METADATA", metadata(version, readme).encode("utf-8"), 0o644),
        (f"{info_dir}/WHEEL", wheel_file(tags).encode("utf-8"), 0o644),
    ]
    files += [(f"{info_dir}/licenses/{name}", path.read_bytes(), 0o644) for name, path in licenses.items()]
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
    for target, (_, kind) in TARGETS.items():
        binary = verified(assets, sums, f"{NAME}-{version}-{target}")
        check_binary(binary, kind, target)
        binaries[target] = binary
    readme = readme_path.read_text(encoding="utf-8")
    out.mkdir(parents=True, exist_ok=True)
    existing = sorted(p.name for p in out.glob("*.whl"))
    if existing:
        raise BuildError(f"{out} already holds wheels ({', '.join(existing)}), so a stale one can't be uploaded with the new ones")
    return [build_wheel(version, TARGETS[target][0], binaries[target], licenses, readme, out) for target in TARGETS]


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
