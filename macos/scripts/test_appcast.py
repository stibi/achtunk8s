"""Tests for appcast.py. Run: python3 -B -m unittest discover -s macos/scripts -p 'test_*.py'"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import plistlib
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout

import appcast
from appcast import Item, Refused

FEED_URL = "https://updates.example.com/tip/appcast.xml"
COMMIT = "4f2a9c1d0e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c"


# --- A throwaway key, to sign with as sign_update does -------------------------------------


def compress(point: appcast.Point) -> bytes:
    inverse = pow(point[2], -1, appcast.P)
    x, y = point[0] * inverse % appcast.P, point[1] * inverse % appcast.P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


class Key:
    def __init__(self, seed: bytes) -> None:
        digest = hashlib.sha512(seed).digest()
        self.scalar = int.from_bytes(digest[:32], "little") & ((1 << 254) - 8) | (1 << 254)
        self.prefix = digest[32:]
        self.public = compress(appcast.point_mul(self.scalar, appcast.BASE))

    @property
    def public_text(self) -> str:
        return base64.b64encode(self.public).decode()

    def sign(self, message: bytes) -> str:
        def number(data: bytes) -> int:
            return int.from_bytes(hashlib.sha512(data).digest(), "little") % appcast.L

        r = number(self.prefix + message)
        commitment = compress(appcast.point_mul(r, appcast.BASE))
        s = (r + number(commitment + self.public + message) * self.scalar) % appcast.L
        return base64.b64encode(commitment + s.to_bytes(32, "little")).decode()

    def sign_feed(self, path: str) -> None:
        """What `sign_update --disable-signing-warning FEED` does."""
        with open(path, "rb") as file:
            content = file.read()
        block = f"<!-- sparkle-signatures:\nedSignature: {self.sign(content)}\nlength: {len(content)}\n-->\n"
        with open(path, "wb") as file:
            file.write(content + block.encode())


KEY = Key(b"\x01" * 32)
OTHER_KEY = Key(b"\x02" * 32)


def item(build: int) -> Item:
    return Item(
        build=build,
        version=f"{build:07x}",
        minimum_system="27.0",
        published="Wed, 18 Nov 2026 10:00:00 +0000",
        url=f"https://updates.example.com/tip/Achtung-{build}.zip",
        length=1000 + build,
        signature="c2ln",
    )


class Release(unittest.TestCase):
    """A folder to publish from, as the release workflow has it."""

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = folder.name
        self.feed = os.path.join(self.folder, "appcast.xml")

    def archive(self, build: int = 431, extra: str | None = None, **changes: object) -> str:
        info: dict[str, object] = {
            "CFBundleVersion": str(build),
            "CFBundleShortVersionString": COMMIT[:7],
            "LSMinimumSystemVersion": "27.0",
            "SUFeedURL": FEED_URL,
            "SUPublicEDKey": KEY.public_text,
            "SURequireSignedFeed": True,
            "SUVerifyUpdateBeforeExtraction": True,
            "SUAllowsAutomaticUpdates": False,
            **changes,
        }
        path = os.path.join(self.folder, f"build-{build}.zip")
        with zipfile.ZipFile(path, "w") as zipped:
            zipped.writestr(appcast.INFO_PLIST, plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
            zipped.writestr("Achtung.app/Contents/MacOS/Achtung", f"binary {build}")
            if extra:
                zipped.writestr(extra, "")
        return path

    def signature(self, archive: str, key: Key = KEY) -> str:
        with open(archive, "rb") as file:
            return key.sign(file.read())

    def run_script(self, *arguments: str, stdin: str = "") -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        real_stdin, appcast.sys.stdin = appcast.sys.stdin, io.StringIO(stdin)
        try:
            with redirect_stdout(out), redirect_stderr(err):
                status = appcast.main(list(arguments))
        finally:
            appcast.sys.stdin = real_stdin
        return status, out.getvalue(), err.getvalue()

    def publish(self, build: int, first: bool = False) -> str:
        """Adds a build to the feed and signs it, as sign-release.sh does."""
        archive = self.archive(build)
        arguments = ["add", self.feed, archive, self.signature(archive)] + (["--first"] if first else [])
        status, _, err = self.run_script(*arguments)
        self.assertEqual(status, 0, err)
        KEY.sign_feed(self.feed)
        return archive

    def builds(self) -> list[int]:
        with open(self.feed, "rb") as file:
            return [entry.build for entry in appcast.parse_feed(appcast.signed_content(file.read(), KEY.public_text))]

    def refused(self, *arguments: str, because: str) -> None:
        status, _, err = self.run_script(*arguments)
        self.assertEqual(status, 1)
        self.assertIn(because, err)


class SignatureTests(unittest.TestCase):
    def test_rfc_8032_vector(self) -> None:
        public = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
        signature = bytes.fromhex(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
            "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
        )
        self.assertTrue(appcast.ed25519_verify(public, b"\x72", signature))
        self.assertFalse(appcast.ed25519_verify(public, b"\x73", signature))
        self.assertFalse(appcast.ed25519_verify(public, b"\x72", signature[:63] + b"\x01"))
        self.assertFalse(appcast.ed25519_verify(public, b"\x72", signature[:32]))
        self.assertFalse(appcast.ed25519_verify(b"\xff" * 32, b"\x72", signature))

    def test_the_test_key_signs_what_the_script_verifies(self) -> None:
        signature = base64.b64decode(KEY.sign(b"an update"))
        self.assertTrue(appcast.ed25519_verify(KEY.public, b"an update", signature))
        self.assertFalse(appcast.ed25519_verify(OTHER_KEY.public, b"an update", signature))


class GuardTests(Release):
    def app(self, archive: str, commit: str = COMMIT) -> tuple[int, str, str]:
        return self.run_script("app", archive, "--commit", commit, "--feed-url", FEED_URL)

    def test_a_release_build_passes_and_says_its_build_number(self) -> None:
        self.assertEqual(self.app(self.archive(431)), (0, "431\n", ""))

    def test_a_build_that_couldnt_update_safely_is_refused(self) -> None:
        for changes, because in [
            ({"SUPublicEDKey": ""}, "SUPublicEDKey is empty"),
            ({"SUPublicEDKey": "bm90IGEga2V5"}, "SUPublicEDKey is 9 bytes"),
            ({"SURequireSignedFeed": False}, "SURequireSignedFeed must be true"),
            ({"SUVerifyUpdateBeforeExtraction": False}, "SUVerifyUpdateBeforeExtraction must be true"),
            ({"SUAllowsAutomaticUpdates": True}, "SUAllowsAutomaticUpdates must be false"),
            ({"SUFeedURL": "http://127.0.0.1:8791/appcast.xml"}, "SUFeedURL"),
            ({"CFBundleVersion": "0"}, "build number"),
            ({"CFBundleVersion": "1.2"}, "build number"),
            ({"CFBundleShortVersionString": COMMIT[:7] + "-dirty"}, "version"),
            ({"CFBundleShortVersionString": "dev"}, "version"),
            ({"LSMinimumSystemVersion": ""}, "LSMinimumSystemVersion"),
        ]:
            with self.subTest(changes):
                status, out, err = self.app(self.archive(**changes))
                self.assertEqual((status, out), (1, ""))
                self.assertIn(because, err)

    def test_a_build_of_another_commit_is_refused(self) -> None:
        status, _, err = self.app(self.archive(), commit="0" * 40)
        self.assertEqual(status, 1)
        self.assertIn("not commit", err)

    def test_an_archive_with_anything_beside_the_app_is_refused(self) -> None:
        self.assertIn("more than Achtung.app", self.app(self.archive(extra="Other.app/x"))[2])
        self.assertIn("more than Achtung.app", self.app(self.archive(extra="../x"))[2])

    def test_a_file_that_isnt_the_archive_is_refused(self) -> None:
        self.assertEqual(self.app(self.feed)[0], 1)
        with open(self.feed, "w") as file:
            file.write("not a zip")
        self.assertEqual(self.app(self.feed)[0], 1)


class FeedTests(unittest.TestCase):
    def test_a_new_build_goes_on_top(self) -> None:
        items = appcast.with_item([item(3), item(1), item(2)], item(4))
        self.assertEqual([entry.build for entry in items], [4, 3, 2, 1])

    def test_only_the_newest_ten_are_kept(self) -> None:
        items = appcast.with_item([item(build) for build in range(1, 11)], item(11))
        self.assertEqual([entry.build for entry in items], list(range(11, 1, -1)))
        self.assertEqual(appcast.KEEP, 10)

    def test_a_build_that_isnt_newer_is_refused(self) -> None:
        for build in (5, 4, 1):
            with self.subTest(build), self.assertRaisesRegex(Refused, "isn't newer than build 5"):
                appcast.with_item([item(3), item(5)], item(build))

    def test_the_first_build_starts_the_feed(self) -> None:
        self.assertEqual(appcast.with_item([], item(1)), [item(1)])

    def test_a_rendered_feed_reads_back_the_same(self) -> None:
        items = [item(12), item(11)]
        awkward = Item(10, "a&b<c", "27.0", 'x "quoted"', "https://e.example/a?b=1&c=2", 5, "c2ln")
        feed = appcast.render_feed([*items, awkward], FEED_URL)
        self.assertEqual(appcast.parse_feed(feed), [*items, awkward])
        self.assertTrue(feed.startswith(b"<?xml"))

    def test_a_feed_someone_else_wrote_is_refused(self) -> None:
        for feed in [b"not xml", b"<rss><channel><item><title>x</title></item></channel></rss>"]:
            with self.subTest(feed), self.assertRaises(Refused):
                appcast.parse_feed(feed)

    def test_stale_archives_are_the_numbered_ones_the_feed_dropped(self) -> None:
        keys = [
            "tip/appcast.xml",
            "tip/Achtung-latest.zip",
            "tip/Achtung-1.zip",
            "tip/Achtung-2.zip",
            "tip/Achtung-3.zip",
            "tip/Achtung-3.zip.bak",
            "stable/Achtung-1.zip",
            "Achtung-1.zip",
        ]
        self.assertEqual(appcast.stale_keys([item(3), item(2)], keys), ["tip/Achtung-1.zip"])

    def test_nothing_is_deleted_when_the_feed_and_the_bucket_disagree(self) -> None:
        with self.assertRaisesRegex(Refused, "lists nothing"):
            appcast.stale_keys([], ["tip/Achtung-1.zip"])
        with self.assertRaisesRegex(Refused, "aren't in the bucket"):
            appcast.stale_keys([item(2)], ["tip/Achtung-1.zip"])


class PublishTests(Release):
    def test_the_first_release_then_the_next(self) -> None:
        first = self.publish(431, first=True)
        self.assertEqual(self.builds(), [431])
        self.assertEqual(self.run_script("check", self.feed, first)[0], 0)

        second = self.publish(432)
        self.assertEqual(self.builds(), [432, 431])
        self.assertEqual(self.run_script("check", self.feed, second)[0], 0)
        self.refused("check", self.feed, first, because="newest build isn't build 431")
        with open(self.feed, "rb") as file:
            feed = file.read().decode()
        self.assertIn('url="https://updates.example.com/tip/Achtung-432.zip"', feed)
        self.assertIn(f'length="{os.path.getsize(second)}"', feed)

    def test_twelve_releases_leave_ten_and_two_to_delete(self) -> None:
        self.publish(1, first=True)
        for build in range(2, 13):
            archive = self.publish(build)
        self.assertEqual(self.builds(), list(range(12, 2, -1)))
        listing = {"Contents": [{"Key": f"tip/Achtung-{build}.zip"} for build in range(1, 13)]}
        listing["Contents"] += [{"Key": "tip/appcast.xml"}, {"Key": "tip/Achtung-latest.zip"}]
        status, out, _ = self.run_script("stale", self.feed, archive, stdin=json.dumps(listing))
        self.assertEqual((status, out), (0, "tip/Achtung-1.zip\ntip/Achtung-2.zip\n"))

    def test_an_old_build_is_refused_and_the_feed_stays(self) -> None:
        self.publish(431, first=True)
        self.publish(432)
        with open(self.feed, "rb") as file:
            before = file.read()
        for build in (432, 431, 7):
            archive = self.archive(build)
            self.refused("add", self.feed, archive, self.signature(archive), because="isn't newer")
        with open(self.feed, "rb") as file:
            self.assertEqual(file.read(), before)

    def test_a_missing_feed_is_never_taken_for_the_first_release(self) -> None:
        archive = self.archive(431)
        self.refused("add", self.feed, archive, self.signature(archive), because="is missing")
        self.assertFalse(os.path.exists(self.feed))
        self.publish(431, first=True)
        archive = self.archive(432)
        self.refused("add", self.feed, archive, self.signature(archive), "--first", because="exists")

    def test_a_feed_that_isnt_signed_with_our_key_is_refused(self) -> None:
        self.publish(431, first=True)
        archive = self.archive(432)
        signature = self.signature(archive)
        with open(self.feed, "rb") as file:
            signed = file.read()

        tampered = signed.replace(b"Achtung-431.zip", b"Achtung-430.zip")
        unsigned = signed[: signed.rfind(appcast.SIGNATURE_PREFIX)]
        for feed, because in [(tampered, "doesn't verify"), (unsigned, "isn't signed")]:
            with open(self.feed, "wb") as file:
                file.write(feed)
            self.refused("add", self.feed, archive, signature, because=because)
            self.refused("check", self.feed, archive, because=because)

        with open(self.feed, "wb") as file:
            file.write(unsigned)
        OTHER_KEY.sign_feed(self.feed)
        self.refused("add", self.feed, archive, signature, because="doesn't verify")

    def test_an_archive_signed_with_another_key_is_refused(self) -> None:
        archive = self.archive(431)
        self.refused(
            "add", self.feed, archive, self.signature(archive, OTHER_KEY), "--first", because="don't belong together"
        )
        self.refused("add", self.feed, archive, "bm90IGEgc2lnbmF0dXJl", "--first", because="signature is")
        self.assertFalse(os.path.exists(self.feed))

    def test_a_feed_that_offers_other_bytes_fails_the_check(self) -> None:
        archive = self.publish(431, first=True)
        with open(archive, "ab") as file:
            file.write(b"\0")
        self.refused("check", self.feed, archive, because="don't belong together")


if __name__ == "__main__":
    unittest.main()
