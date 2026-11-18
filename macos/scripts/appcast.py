#!/usr/bin/env python3
"""The update feed of the macOS client (ADR 0021): checks a release archive, adds it to
the Sparkle appcast, and says which archives the feed no longer lists.

    appcast.py app ARCHIVE --commit SHA --feed-url URL   the Info.plist guard; prints the build number
    appcast.py add FEED ARCHIVE SIGNATURE [--first]      writes FEED with the archive on top, unsigned
    appcast.py check FEED ARCHIVE                        FEED is signed and offers ARCHIVE as the newest
    appcast.py stale FEED ARCHIVE < listing.json         the bucket's keys that FEED no longer lists

It never sees the private key: `sign_update` signs the archive and the feed
(sign-release.sh), and this script verifies both with the public key compiled into the
app inside the archive. Standard library only, and Python 3.9, which is what Xcode ships.
Tests: test_appcast.py.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import plistlib
import re
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from urllib.parse import urlsplit
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr

KEEP = 10
"""How many builds the feed lists. Archives that drop out of it are deleted."""

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
INFO_PLIST = "Achtung.app/Contents/Info.plist"
SIGNATURE_PREFIX = b"<!-- sparkle-signatures:\n"
SIGNATURE_SUFFIX = b"-->"


class Refused(Exception):
    """Why this release must not be published."""


# --- Ed25519 verification (RFC 8032, section 6) -------------------------------------------
# Verification only, so no secret is ever in this process and timing doesn't matter.

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, -1, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)

Point = tuple  # (X, Y, Z, T), extended coordinates


def point_add(p: Point, q: Point) -> Point:
    a = (p[1] - p[0]) * (q[1] - q[0]) % P
    b = (p[1] + p[0]) * (q[1] + q[0]) % P
    c = 2 * p[3] * q[3] * D % P
    d = 2 * p[2] * q[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def point_mul(scalar: int, p: Point) -> Point:
    q: Point = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            q = point_add(q, p)
        p = point_add(p, p)
        scalar >>= 1
    return q


def point_equal(p: Point, q: Point) -> bool:
    return (p[0] * q[2] - q[0] * p[2]) % P == 0 and (p[1] * q[2] - q[1] * p[2]) % P == 0


def recover_x(y: int, sign: int) -> int | None:
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, -1, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P != 0:
        return None
    return P - x if (x & 1) != sign else x


BASE_Y = 4 * pow(5, -1, P) % P
BASE_X = recover_x(BASE_Y, 0)
assert BASE_X is not None
BASE: Point = (BASE_X, BASE_Y, 1, BASE_X * BASE_Y % P)


def point_decompress(data: bytes) -> Point | None:
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(signature) != 64:
        return False
    a = point_decompress(public_key)
    r = point_decompress(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if a is None or r is None or s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little")
    return point_equal(point_mul(s, BASE), point_add(r, point_mul(h % L, a)))


def decode(text: str, length: int, what: str) -> bytes:
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise Refused(f"{what} isn't base64") from None
    if len(data) != length:
        raise Refused(f"{what} is {len(data)} bytes, not {length}")
    return data


# --- The archive -------------------------------------------------------------------------


@dataclass(frozen=True)
class App:
    """What the feed says about one build, read from the app inside its archive."""

    build: int
    version: str
    minimum_system: str
    public_key: str
    feed_url: str

    @property
    def archive_url(self) -> str:
        return f"{self.feed_url.rsplit('/', 1)[0]}/Achtung-{self.build}.zip"


def read_app(archive: str) -> App:
    """The guard: an archive whose app couldn't update itself safely is never published."""
    try:
        with zipfile.ZipFile(archive) as zipped:
            names = zipped.namelist()
            info = plistlib.loads(zipped.read(INFO_PLIST))
    except (OSError, KeyError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        raise Refused(f"{archive}: no readable {INFO_PLIST} ({error})") from None
    if any(not name.startswith("Achtung.app/") for name in names):
        raise Refused(f"{archive} holds more than Achtung.app")

    for key in ("SURequireSignedFeed", "SUVerifyUpdateBeforeExtraction"):
        if info.get(key) is not True:
            raise Refused(f"Info.plist: {key} must be true")
    if info.get("SUAllowsAutomaticUpdates") is not False:
        raise Refused("Info.plist: SUAllowsAutomaticUpdates must be false")
    public_key = str(info.get("SUPublicEDKey", "")).strip()
    if not public_key:
        raise Refused("Info.plist: SUPublicEDKey is empty, so this build could never update")
    decode(public_key, 32, "Info.plist: SUPublicEDKey")
    build = str(info.get("CFBundleVersion", ""))
    if not re.fullmatch(r"[1-9][0-9]*", build):
        raise Refused(f"Info.plist: the build number is {build!r}, not a positive number")
    minimum_system = str(info.get("LSMinimumSystemVersion", ""))
    if not re.fullmatch(r"[0-9]+(\.[0-9]+){0,2}", minimum_system):
        raise Refused(f"Info.plist: LSMinimumSystemVersion is {minimum_system!r}")
    return App(
        build=int(build),
        version=str(info.get("CFBundleShortVersionString", "")),
        minimum_system=minimum_system,
        public_key=public_key,
        feed_url=str(info.get("SUFeedURL", "")),
    )


def check_app(app: App, commit: str, feed_url: str) -> None:
    """The archive is a build of this commit, clean, and reads the real feed."""
    if not re.fullmatch(r"[0-9a-f]{7,40}", app.version) or not commit.startswith(app.version):
        raise Refused(f"Info.plist: the version is {app.version!r}, not commit {commit}")
    if app.feed_url != feed_url:
        raise Refused(f"Info.plist: SUFeedURL is {app.feed_url!r}, not {feed_url!r}")


def check_archive_signature(app: App, archive: str, signature: str) -> int:
    """The archive's length, once its signature verifies with the app's own public key."""
    with open(archive, "rb") as file:
        data = file.read()
    public_key = decode(app.public_key, 32, "SUPublicEDKey")
    if not ed25519_verify(public_key, data, decode(signature, 64, "the archive's signature")):
        raise Refused(
            "the archive's signature doesn't verify with the public key in its Info.plist: "
            "the signing key and ACHTUNG_UPDATE_PUBLIC_KEY don't belong together"
        )
    return len(data)


# --- The feed ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    build: int
    version: str
    minimum_system: str
    published: str
    url: str
    length: int
    signature: str


def signed_content(feed: bytes, public_key: str) -> bytes:
    """The feed without its signature block (as Sparkle's SPUExtractAppcastContent finds
    it), once that signature verifies. Nothing in a feed is trusted before this."""
    start = feed.rfind(SIGNATURE_PREFIX)
    end = feed.find(SIGNATURE_SUFFIX, start + len(SIGNATURE_PREFIX)) if start >= 0 else -1
    if end < 0:
        raise Refused("the feed isn't signed")
    fields = dict(
        line.split(":", 1)
        for line in feed[start + len(SIGNATURE_PREFIX) : end].decode("ascii", "replace").splitlines()
        if ":" in line
    )
    content = feed[:start]
    signature = decode(fields.get("edSignature", "").strip(), 64, "the feed's signature")
    if not ed25519_verify(decode(public_key, 32, "SUPublicEDKey"), content, signature):
        raise Refused("the feed's signature doesn't verify with the app's public key")
    return content


def parse_feed(content: bytes) -> list[Item]:
    """The feed's items, newest first. A feed this script didn't write is refused."""

    def text(item: ElementTree.Element, name: str) -> str:
        value = item.findtext(name)
        if not value:
            raise Refused(f"the feed has an item without {name}")
        return value

    try:
        root = ElementTree.fromstring(content)
        items = []
        for element in root.iterfind("channel/item"):
            enclosure = element.find("enclosure")
            if enclosure is None:
                raise Refused("the feed has an item without an enclosure")
            items.append(
                Item(
                    build=int(text(element, f"{{{SPARKLE}}}version")),
                    version=text(element, f"{{{SPARKLE}}}shortVersionString"),
                    minimum_system=text(element, f"{{{SPARKLE}}}minimumSystemVersion"),
                    published=text(element, "pubDate"),
                    url=enclosure.attrib["url"],
                    length=int(enclosure.attrib["length"]),
                    signature=enclosure.attrib[f"{{{SPARKLE}}}edSignature"],
                )
            )
    except (ElementTree.ParseError, KeyError, ValueError) as error:
        raise Refused(f"the feed can't be read: {error}") from None
    return sorted(items, key=lambda item: item.build, reverse=True)


def with_item(items: list[Item], new: Item) -> list[Item]:
    """The feed's items with a new build on top, the newest KEEP of them. A build that
    isn't newer than every listed one is refused, so a re-run of an old commit can never
    become "latest"."""
    newest = max((item.build for item in items), default=0)
    if new.build <= newest:
        raise Refused(f"build {new.build} isn't newer than build {newest}, which the feed has")
    return sorted([new, *items], key=lambda item: item.build, reverse=True)[:KEEP]


def render_feed(items: list[Item], feed_url: str) -> bytes:
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        f'<rss version="2.0" xmlns:sparkle="{SPARKLE}">',
        "  <channel>",
        "    <title>Achtung</title>",
        f"    <link>{escape(feed_url)}</link>",
        "    <description>Builds of main, newest first.</description>",
        "    <language>en</language>",
    ]
    for item in items:
        lines += [
            "    <item>",
            f"      <title>{escape(item.version)}</title>",
            f"      <pubDate>{escape(item.published)}</pubDate>",
            f"      <sparkle:version>{item.build}</sparkle:version>",
            f"      <sparkle:shortVersionString>{escape(item.version)}</sparkle:shortVersionString>",
            f"      <sparkle:minimumSystemVersion>{escape(item.minimum_system)}</sparkle:minimumSystemVersion>",
            f"      <enclosure url={quoteattr(item.url)} length=\"{item.length}\""
            f' type="application/octet-stream" sparkle:edSignature={quoteattr(item.signature)}/>',
            "    </item>",
        ]
    lines += ["  </channel>", "</rss>", ""]
    return "\n".join(lines).encode()


def stale_keys(items: list[Item], keys: list[str]) -> list[str]:
    """The numbered archives next to the listed ones that the feed no longer lists.
    Nothing else in the bucket is ever named: not the feed, not Achtung-latest.zip."""
    listed = {urlsplit(item.url).path.lstrip("/") for item in items}
    if not listed:
        raise Refused("the feed lists nothing, so nothing is deleted")
    missing = listed - set(keys)
    if missing:
        raise Refused(f"the feed lists archives that aren't in the bucket: {sorted(missing)}")
    folders = {key.rsplit("/", 1)[0] for key in listed}
    return sorted(
        key
        for key in keys
        if key not in listed
        and key.rsplit("/", 1)[0] in folders
        and re.fullmatch(r"Achtung-[0-9]+\.zip", key.rsplit("/", 1)[-1])
    )


# --- Commands ----------------------------------------------------------------------------


def read(path: str) -> bytes:
    with open(path, "rb") as file:
        return file.read()


def command_app(args: argparse.Namespace) -> None:
    app = read_app(args.archive)
    check_app(app, args.commit, args.feed_url)
    print(app.build)


def command_add(args: argparse.Namespace) -> None:
    app = read_app(args.archive)
    length = check_archive_signature(app, args.archive, args.signature)
    # The caller says whether this is the first release. A feed that failed to download
    # must never look like one: the build guard and the older builds would be gone.
    if args.first == os.path.exists(args.feed):
        raise Refused(f"{args.feed} exists" if args.first else f"{args.feed} is missing")
    items = [] if args.first else parse_feed(signed_content(read(args.feed), app.public_key))
    new = Item(
        build=app.build,
        version=app.version,
        minimum_system=app.minimum_system,
        published=format_datetime(datetime.now(timezone.utc)),
        url=app.archive_url,
        length=length,
        signature=args.signature,
    )
    feed = render_feed(with_item(items, new), app.feed_url)
    temporary = f"{args.feed}.new"
    with open(temporary, "wb") as file:
        file.write(feed)
    os.replace(temporary, args.feed)


def command_check(args: argparse.Namespace) -> None:
    app = read_app(args.archive)
    items = parse_feed(signed_content(read(args.feed), app.public_key))
    newest = items[0] if items else None
    if newest is None or newest.build != app.build or newest.url != app.archive_url:
        raise Refused(f"the feed's newest build isn't build {app.build}")
    if len(items) > KEEP:
        raise Refused(f"the feed lists {len(items)} builds, more than {KEEP}")
    if check_archive_signature(app, args.archive, newest.signature) != newest.length:
        raise Refused("the feed's length for the newest build isn't the archive's")


def command_stale(args: argparse.Namespace) -> None:
    items = parse_feed(signed_content(read(args.feed), read_app(args.archive).public_key))
    # `aws s3api list-objects-v2 --output json`.
    listing = json.load(sys.stdin)
    for key in stale_keys(items, [entry["Key"] for entry in listing.get("Contents") or []]):
        print(key)


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(required=True)

    app = commands.add_parser("app")
    app.add_argument("archive")
    app.add_argument("--commit", required=True)
    app.add_argument("--feed-url", required=True)
    app.set_defaults(run=command_app)

    add = commands.add_parser("add")
    add.add_argument("feed")
    add.add_argument("archive")
    add.add_argument("signature")
    add.add_argument("--first", action="store_true", help="there is no feed yet")
    add.set_defaults(run=command_add)

    check = commands.add_parser("check")
    check.add_argument("feed")
    check.add_argument("archive")
    check.set_defaults(run=command_check)

    stale = commands.add_parser("stale")
    stale.add_argument("feed")
    stale.add_argument("archive")
    stale.set_defaults(run=command_stale)

    args = parser.parse_args(arguments)
    try:
        args.run(args)
    except Refused as refused:
        print(f"Refused: {refused}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
