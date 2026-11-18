#!/usr/bin/env bash
# Every check for the macOS client: format, lint, package tests, the release scripts'
# tests, app build and tests, dead code. Exits non-zero on the first failure. macOS only; needs xcodegen, swiftlint and
# periphery (brew install xcodegen swiftlint periphery).
set -euo pipefail

cd "$(dirname "$0")/.."
derived_data=.build/DerivedData

step() { printf '\n==> %s\n' "$*"; }

step xcodegen
xcodegen generate --quiet

step "swift format"
swift format lint --strict --recursive --parallel Achtung Packages/*/Package.swift \
  Packages/*/Sources Packages/*/Tests

step swiftlint
swiftlint lint --strict --quiet

# With the versions in Package.resolved, and without rewriting it. Xcode keeps the app's
# own pins (Sparkle) in AchtungAPI's Package.resolved; left to resolve, `swift test` drops
# them and Xcode writes the file again, so a fresh checkout is never clean after a check,
# and the release workflow refuses to build from a changed tree.
for package in Packages/*/; do
  step "swift test ($package)"
  swift test --quiet --only-use-versions-from-resolved-file --package-path "$package"
done

step "release scripts"
# The update feed's script (ADR 0021). The release workflow runs it with the signing key
# next to it, so its tests gate every release.
python3 -B -m unittest discover --quiet -s scripts -p 'test_*.py'

step "xcodebuild build test"
# AchtungAPI uses swift-openapi-generator's build plugin. Xcode asks to trust a plugin
# once; scripts and CI can't answer, so they skip that prompt.
xcodebuild build test -quiet -skipPackagePluginValidation \
  -project Achtung.xcodeproj -scheme Achtung -destination platform=macOS \
  -derivedDataPath "$derived_data" COMPILER_INDEX_STORE_ENABLE=YES

step periphery
periphery scan --quiet --skip-build --index-store-path "$derived_data/Index.noindex/DataStore"
