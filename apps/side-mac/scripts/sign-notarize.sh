#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
entitlements="$package_dir/Side.entitlements"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

required_string() {
  value=$(plutil -extract "$1" raw -o - "$2") || fail "Missing Info.plist key: $1"
  [ -n "$value" ] || fail "Empty Info.plist key: $1"
}

preflight() {
  app=$1
  [ -d "$app/Contents" ] || fail "Missing app bundle: $app"
  for item in \
    Contents/MacOS/Side \
    Contents/Resources/side \
    Contents/Resources/lib/libsqlite3.dylib \
    Contents/Resources/lib/vec0.dylib \
    Contents/Resources/lib/libonnxruntime.1.dylib; do
    [ -f "$app/$item" ] || fail "Missing bundle code: $item"
  done
  plutil -lint "$app/Contents/Info.plist" "$entitlements" >/dev/null || fail "Invalid release plist"
  required_string NSAppleEventsUsageDescription "$app/Contents/Info.plist"
  required_string NSScreenCaptureUsageDescription "$app/Contents/Info.plist"
  enabled=$(plutil -extract 'com\.apple\.security\.automation\.apple-events' raw -o - "$entitlements") || fail "Missing Apple Events entitlement"
  [ "$enabled" = true ] || fail "Apple Events entitlement is disabled"
  printf '%s\n' "PASS release preflight: $app"
}

case "${1:-}" in
  preflight)
    [ "$#" -eq 2 ] || fail "Usage: $0 preflight Side.app"
    preflight "$2"
    ;;
  release)
    [ "$#" -eq 5 ] || fail "Usage: $0 release Side.app 'Developer ID Application: ...' keychain-profile output.zip"
    source_app=$2
    identity=$3
    profile=$4
    output_zip=$5
    preflight "$source_app"
    case "$identity" in
      "Developer ID Application: "*) ;;
      *) fail "A Developer ID Application identity is required" ;;
    esac
    [ -n "$profile" ] || fail "A notarytool keychain profile is required"
    [ ! -e "$output_zip" ] || fail "Output ZIP already exists: $output_zip"
    output_parent=$(dirname -- "$output_zip")
    [ -d "$output_parent" ] || fail "Output directory does not exist: $output_parent"
    security find-identity -v -p codesigning | grep -F "\"$identity\"" >/dev/null || fail "Developer ID identity is not installed: $identity"

    work_dir=$(mktemp -d "${TMPDIR:-/tmp}/side-notarize.XXXXXX")
    output_work_dir=$(mktemp -d "$output_parent/.side-release.XXXXXX")
    trap 'rm -rf "$work_dir" "$output_work_dir"' 0
    trap 'exit 1' 1 2 3 15
    app="$work_dir/Side.app"
    ditto "$source_app" "$app"
    resources="$app/Contents/Resources"

    for item in \
      "$resources/lib/libsqlite3.dylib" \
      "$resources/lib/vec0.dylib" \
      "$resources/lib/libonnxruntime.1.dylib" \
      "$resources/side"; do
      codesign --force --sign "$identity" --options runtime --timestamp "$item"
    done
    codesign --force --sign "$identity" --options runtime --timestamp --entitlements "$entitlements" "$app"
    codesign --verify --deep --strict --verbose=2 "$app"

    upload_zip="$work_dir/Side-upload.zip"
    ditto -c -k --keepParent "$app" "$upload_zip"
    submission=$(xcrun notarytool submit "$upload_zip" --keychain-profile "$profile" --wait --output-format json)
    status=$(printf '%s' "$submission" | plutil -extract status raw -o - -) || fail "Could not read notarization status"
    submission_id=$(printf '%s' "$submission" | plutil -extract id raw -o - -) || fail "Could not read notarization submission ID"
    printf 'Notarization %s: %s\n' "$submission_id" "$status"
    [ "$status" = Accepted ] || fail "Notarization was not accepted: $status"

    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    assessment=$(spctl -a -vv "$app" 2>&1) || fail "Gatekeeper rejected stapled app: $assessment"
    case "$assessment" in
      *accepted*"source=Notarized Developer ID"*) ;;
      *) fail "Gatekeeper did not report Notarized Developer ID: $assessment" ;;
    esac
    ditto -c -k --keepParent "$app" "$output_work_dir/Side.zip"
    [ ! -e "$output_zip" ] || fail "Output ZIP appeared during release: $output_zip"
    mv "$output_work_dir/Side.zip" "$output_zip"
    printf 'PASS signed and notarized release: %s\n' "$output_zip"
    ;;
  *) fail "Usage: $0 preflight Side.app | release Side.app identity keychain-profile output.zip" ;;
esac
