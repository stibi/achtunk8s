#!/usr/bin/env bash
# Signs a release archive and adds it to the update feed (ADR 0021):
#   sign-release.sh ARCHIVE FEED_DIR < private-key
# FEED_DIR holds the published appcast.xml, or nothing with FIRST_RELEASE=1. Afterwards it
# holds the new signed appcast.xml and the archive as Achtung-<build>.zip, ready to upload.
# Needs COMMIT (the commit the archive was built from), FEED_URL (the feed's public
# address) and SIGN_UPDATE (Sparkle's sign_update, at the app's Sparkle version).
#
# The private key comes on stdin, one line, and goes to sign_update's stdin: never into
# an argument, a file, the environment or the output. sign_update's own output is kept off the log, because
# it prints a key it can't decode. Everything signed is then verified with the public key
# compiled into the app (appcast.py), so a wrong key can't be published.
set -euo pipefail

archive=$1
feed_dir=$2
feed="$feed_dir/appcast.xml"
appcast=(python3 -B "$(dirname "$0")/appcast.py")

fail() {
  echo "sign-release: $*" >&2
  exit 1
}

IFS= read -r key || [[ -n "$key" ]] || fail "no private key on stdin"

# The guard: a clean build of this commit that reads the real feed and has the public key.
build=$("${appcast[@]}" app "$archive" --commit "$COMMIT" --feed-url "$FEED_URL")

signature=$(printf '%s\n' "$key" | "$SIGN_UPDATE" --ed-key-file - -p "$archive" 2>/dev/null) ||
  fail "sign_update couldn't sign the archive (is the private key the one generate_keys exported?)"
[[ "$signature" =~ ^[A-Za-z0-9+/]{86}==$ ]] || fail "sign_update didn't print a signature"

if [[ "${FIRST_RELEASE:-}" == 1 ]]; then
  "${appcast[@]}" add "$feed" "$archive" "$signature" --first
else
  "${appcast[@]}" add "$feed" "$archive" "$signature"
fi

# Without the warning comment sign_update would re-serialize the feed to add.
printf '%s\n' "$key" | "$SIGN_UPDATE" --ed-key-file - --disable-signing-warning "$feed" >/dev/null 2>&1 ||
  fail "sign_update couldn't sign the feed"
unset key

"${appcast[@]}" check "$feed" "$archive"
cp "$archive" "$feed_dir/Achtung-$build.zip"
echo "Signed build $build"
