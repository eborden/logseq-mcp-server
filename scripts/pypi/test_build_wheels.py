"""Tests of build_wheels.py (ADR-0036). Run: python3 -I -m unittest discover -s scripts/pypi

They use made-up binaries (a real Mach-O or ELF header and a few bytes of filler), never a release and never the
network (BR-0001).
"""
import base64
import contextlib
import hashlib
import io
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

import build_wheels as bw

VERSION = "9.8.7"
MACHO_ARM64 = bw.MACHO_MAGIC + struct.pack("<I", bw.MACHO_CPU_ARM64) + b"filler arm64"
MACHO_X86_64 = bw.MACHO_MAGIC + struct.pack("<I", bw.MACHO_CPU_X86_64) + b"filler x86_64"
ELF_X86_64 = bw.ELF_MAGIC + bytes([2, 1, 1, 0]) + bytes(8) + struct.pack("<HH", 3, bw.ELF_MACHINE_X86_64) + b"filler musl"
BINARIES = {
    "aarch64-apple-darwin": MACHO_ARM64,
    "x86_64-apple-darwin": MACHO_X86_64,
    "x86_64-unknown-linux-musl": ELF_X86_64,
}
WHEELS = {
    "aarch64-apple-darwin": f"logseq_mcp_server-{VERSION}-py3-none-macosx_11_0_arm64.whl",
    "x86_64-apple-darwin": f"logseq_mcp_server-{VERSION}-py3-none-macosx_10_12_x86_64.whl",
    "x86_64-unknown-linux-musl": f"logseq_mcp_server-{VERSION}-py3-none-manylinux_2_17_x86_64.musllinux_1_2_x86_64.whl",
}
DATA = f"logseq_mcp_server-{VERSION}.data"
INFO = f"logseq_mcp_server-{VERSION}.dist-info"


def write_sums(assets: Path, skip: tuple = ()) -> None:
    lines = [
        f"{bw.sha256_file(p)}  {p.name}"
        for p in sorted(assets.iterdir())
        if p.name != "SHA256SUMS" and p.name not in skip
    ]
    (assets / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


class Case(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.assets = self.root / "assets"
        self.out = self.root / "out"
        self.assets.mkdir()
        for target, data in BINARIES.items():
            (self.assets / f"logseq-mcp-server-{VERSION}-{target}").write_bytes(data)
        (self.assets / "LICENSE").write_text("MIT License\nmade up\n", encoding="utf-8")
        (self.assets / "THIRD-PARTY-NOTICES.txt").write_text("notices, made up\n", encoding="utf-8")
        self.readme = self.root / "README.md"
        self.readme.write_text("# Made-up readme\n\nBody.\n", encoding="utf-8")
        write_sums(self.assets)

    def build(self, version=VERSION):
        return bw.build(version, self.assets, self.readme, self.out)

    def wheel(self, target):
        return zipfile.ZipFile(self.out / WHEELS[target])


class BuildsWheels(Case):
    def test_one_wheel_per_target_with_the_platform_tags(self):
        wheels = self.build()
        self.assertEqual([w.name for w in wheels], list(WHEELS.values()))
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), sorted(WHEELS.values()))

    def test_the_binary_is_the_asset_byte_for_byte_and_executable(self):
        self.build()
        for target in WHEELS:
            with self.subTest(target=target), self.wheel(target) as wheel:
                path = f"{DATA}/scripts/logseq-mcp-server"
                self.assertEqual(wheel.read(path), BINARIES[target])
                mode = wheel.getinfo(path).external_attr >> 16
                self.assertEqual(mode & 0o777, 0o755)
                self.assertTrue(mode & 0o100000, "a regular file")

    def test_only_the_binary_is_executable(self):
        self.build()
        with self.wheel("x86_64-unknown-linux-musl") as wheel:
            executable = [i.filename for i in wheel.infolist() if (i.external_attr >> 16) & 0o111]
        self.assertEqual(executable, [f"{DATA}/scripts/logseq-mcp-server"])

    def test_the_wheel_holds_exactly_the_expected_files(self):
        self.build()
        with self.wheel("aarch64-apple-darwin") as wheel:
            self.assertEqual(
                wheel.namelist(),
                [
                    f"{DATA}/scripts/logseq-mcp-server",
                    f"{INFO}/METADATA",
                    f"{INFO}/WHEEL",
                    f"{INFO}/licenses/LICENSE",
                    f"{INFO}/licenses/THIRD-PARTY-NOTICES.txt",
                    f"{INFO}/RECORD",
                ],
            )
            self.assertIsNone(wheel.testzip())

    def test_record_lists_every_file_with_its_hash_and_size(self):
        self.build()
        for target in WHEELS:
            with self.subTest(target=target), self.wheel(target) as wheel:
                record_path = f"{INFO}/RECORD"
                rows = [line.split(",") for line in wheel.read(record_path).decode().splitlines()]
                self.assertEqual(sorted(r[0] for r in rows), sorted(wheel.namelist()))
                for path, digest, size in rows:
                    if path == record_path:
                        self.assertEqual((digest, size), ("", ""))
                        continue
                    data = wheel.read(path)
                    expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
                    self.assertEqual(digest, f"sha256={expected}", path)
                    self.assertEqual(int(size), len(data), path)

    def test_wheel_file_names_every_tag_of_the_file_name(self):
        self.build()
        with self.wheel("x86_64-unknown-linux-musl") as wheel:
            text = wheel.read(f"{INFO}/WHEEL").decode()
        self.assertIn("Root-Is-Purelib: false\n", text)
        self.assertIn("Tag: py3-none-manylinux_2_17_x86_64\n", text)
        self.assertIn("Tag: py3-none-musllinux_1_2_x86_64\n", text)

    def test_metadata_names_the_project_licence_and_readme(self):
        self.build()
        with self.wheel("aarch64-apple-darwin") as wheel:
            text = wheel.read(f"{INFO}/METADATA").decode()
        head, _, body = text.partition("\n\n")
        for line in (
            "Metadata-Version: 2.4",
            "Name: logseq-mcp-server",
            f"Version: {VERSION}",
            "License-Expression: MIT",
            "License-File: LICENSE",
            "License-File: THIRD-PARTY-NOTICES.txt",
            "Requires-Python: >=3.9",
            "Description-Content-Type: text/markdown",
            "Project-URL: Source, https://github.com/eborden/logseq-mcp-server",
        ):
            self.assertIn(line, head.splitlines())
        self.assertEqual(body, "# Made-up readme\n\nBody.\n")

    def test_licence_files_ship_in_the_wheel(self):
        self.build()
        with self.wheel("x86_64-apple-darwin") as wheel:
            self.assertEqual(wheel.read(f"{INFO}/licenses/LICENSE"), (self.assets / "LICENSE").read_bytes())
            self.assertEqual(
                wheel.read(f"{INFO}/licenses/THIRD-PARTY-NOTICES.txt"),
                (self.assets / "THIRD-PARTY-NOTICES.txt").read_bytes(),
            )

    def test_building_twice_gives_the_same_bytes(self):
        first = [p.read_bytes() for p in self.build()]
        for p in self.out.glob("*.whl"):
            p.unlink()
        self.assertEqual([p.read_bytes() for p in self.build()], first)

    def test_leaves_no_partial_file(self):
        self.build()
        self.assertEqual([p.name for p in self.out.iterdir() if not p.name.endswith(".whl")], [])


class RefusesToBuild(Case):
    def refused(self, pattern, version=VERSION):
        with self.assertRaisesRegex(bw.BuildError, pattern):
            self.build(version)
        self.assertEqual(list(self.out.glob("*")) if self.out.exists() else [], [], "nothing is written")

    def test_a_binary_that_does_not_match_its_checksum(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-aarch64-apple-darwin").write_bytes(MACHO_ARM64 + b"tampered")
        self.refused("does not match SHA256SUMS")

    def test_a_licence_file_that_does_not_match_its_checksum(self):
        (self.assets / "LICENSE").write_text("changed\n", encoding="utf-8")
        self.refused("LICENSE does not match SHA256SUMS")

    def test_a_binary_that_sha256sums_does_not_list(self):
        write_sums(self.assets, skip=(f"logseq-mcp-server-{VERSION}-x86_64-apple-darwin",))
        self.refused("x86_64-apple-darwin is not listed in SHA256SUMS")

    def test_a_missing_binary(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-x86_64-unknown-linux-musl").unlink()
        self.refused("x86_64-unknown-linux-musl is missing")

    def test_a_missing_sha256sums(self):
        (self.assets / "SHA256SUMS").unlink()
        self.refused("SHA256SUMS is missing")

    def test_a_malformed_sha256sums_line(self):
        with (self.assets / "SHA256SUMS").open("a", encoding="utf-8") as handle:
            handle.write("not a checksum line\n")
        self.refused("is not a sha256sum line")

    def test_a_file_name_with_a_path_in_sha256sums(self):
        with (self.assets / "SHA256SUMS").open("a", encoding="utf-8") as handle:
            handle.write(f"{'0' * 64}  ../escape\n")
        self.refused("is not a sha256sum line")

    def test_a_duplicate_sha256sums_entry(self):
        sums = self.assets / "SHA256SUMS"
        text = sums.read_text(encoding="utf-8")
        sums.write_text(text + text.splitlines()[0] + "\n", encoding="utf-8")
        self.refused("lists .* twice")

    def test_an_x86_64_binary_under_the_arm64_target(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-aarch64-apple-darwin").write_bytes(MACHO_X86_64)
        write_sums(self.assets)
        self.refused("is not a 64-bit arm64 Mach-O")

    def test_an_arm64_binary_under_the_x86_64_target(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-x86_64-apple-darwin").write_bytes(MACHO_ARM64)
        write_sums(self.assets)
        self.refused("is not a 64-bit x86_64 Mach-O")

    def test_a_macho_binary_under_the_linux_target(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-x86_64-unknown-linux-musl").write_bytes(MACHO_X86_64)
        write_sums(self.assets)
        self.refused("is not a 64-bit x86_64 ELF")

    def test_an_aarch64_elf_under_the_linux_target(self):
        arm = bw.ELF_MAGIC + bytes([2, 1, 1, 0]) + bytes(8) + struct.pack("<HH", 3, 0xB7)
        (self.assets / f"logseq-mcp-server-{VERSION}-x86_64-unknown-linux-musl").write_bytes(arm)
        write_sums(self.assets)
        self.refused("is not a 64-bit x86_64 ELF")

    def test_a_file_too_short_to_have_a_header(self):
        (self.assets / f"logseq-mcp-server-{VERSION}-aarch64-apple-darwin").write_bytes(b"\xcf")
        write_sums(self.assets)
        self.refused("is not a 64-bit arm64 Mach-O")

    def test_a_version_that_is_not_plain_x_y_z(self):
        for version in ("1.0", "v1.0.0", "1.0.0-rc1", "1.0.0\n", "../1.0.0", ""):
            with self.subTest(version=version), self.assertRaisesRegex(bw.BuildError, "plain x.y.z"):
                self.build(version)

    def test_a_missing_readme(self):
        self.readme.unlink()
        self.refused("README.md is missing")

    def test_an_output_directory_that_already_holds_wheels(self):
        self.build()
        with self.assertRaisesRegex(bw.BuildError, "already holds wheels"):
            self.build()


class CommandLine(Case):
    def run_main(self):
        return bw.main(["--version", VERSION, "--assets", str(self.assets), "--readme", str(self.readme), "--out", str(self.out)])

    def test_exit_status_zero_and_one_line_per_wheel(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(self.run_main(), 0)
        lines = buffer.getvalue().splitlines()
        self.assertEqual([line.split("  sha256=")[0] for line in lines], list(WHEELS.values()))
        for line in lines:
            name, digest = line.split("  sha256=")
            self.assertEqual(bw.sha256_file(self.out / name), digest)

    def test_exit_status_one_and_a_message_on_stderr(self):
        (self.assets / "LICENSE").write_text("changed\n", encoding="utf-8")
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            self.assertEqual(self.run_main(), 1)
        self.assertIn("build_wheels: LICENSE does not match SHA256SUMS", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
