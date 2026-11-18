#!/usr/bin/env bash
# Builds a Release Achtung.app and prints its path. The version is the commit hash (with
# -dirty for uncommitted changes), the build number the commit count, which is what the
# updater compares (ADR 0021). install.sh installs the result; the release workflow
# publishes it. Arguments go to xcodebuild, e.g. to test against a local feed:
#   build-release.sh ACHTUNG_UPDATE_FEED_URL=http://127.0.0.1:8791/appcast.xml ACHTUNG_UPDATE_PUBLIC_KEY=…
# Rebuilds are incremental.
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(git rev-parse --short HEAD)
[[ -z "$(git status --porcelain)" ]] || version+="-dirty"
build=$(git rev-list --count HEAD)
derived_data=.build/Release

# Only the path goes to stdout.
{
  xcodegen generate --quiet
  xcodebuild build -quiet -skipPackagePluginValidation \
    -project Achtung.xcodeproj -scheme Achtung -configuration Release -destination platform=macOS \
    -derivedDataPath "$derived_data" MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" "$@"
} >&2
echo "$PWD/$derived_data/Build/Products/Release/Achtung.app"
