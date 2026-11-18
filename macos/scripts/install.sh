#!/usr/bin/env bash
# Builds a Release Achtung.app (build-release.sh: the version is the commit hash, the
# build number the commit count) and installs it into ~/Applications, where Spotlight and
# Raycast find it. Rebuilds are incremental, so an update takes seconds. A running
# Achtung is quit first and the new one started. The installed copy updates itself from
# the public feed like a downloaded one (ADR 0021).
set -euo pipefail

cd "$(dirname "$0")/.."
installed="$HOME/Applications/Achtung.app"

built=$(scripts/build-release.sh "$@")

if pgrep -xq Achtung; then
  osascript -e 'tell application id "io.github.stibi.achtung" to quit'
  for _ in {1..50}; do pgrep -xq Achtung || break; sleep 0.1; done
fi
mkdir -p "$(dirname "$installed")"
rm -rf "$installed"
ditto "$built" "$installed"
open "$installed"
version=$(defaults read "$installed/Contents/Info" CFBundleShortVersionString)
build=$(defaults read "$installed/Contents/Info" CFBundleVersion)
echo "Installed Achtung $version ($build) to $installed"
