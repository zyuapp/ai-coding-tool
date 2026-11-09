#!/bin/zsh
# Archives the app and uploads it to TestFlight. With ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH set
# (an App Store Connect key with the App Manager role), the upload goes through that key, and
# IOS_PROFILE_UUID names an installed App Store profile whose Apple Distribution certificate is in a
# keychain; without them, signing and upload go through the Apple ID signed in to Xcode. The archive
# is built unsigned because automatic signing would ask for a development profile, which needs a
# registered device; the export signs it for the App Store instead. MARKETING_VERSION names the
# version; each upload gets a fresh build number, which is what TestFlight orders builds by.
set -euo pipefail
cd "${0:A:h}"

build=$(date -u +%Y%m%d%H%M)
out=build/testflight
auth=(-allowProvisioningUpdates)
if [[ -n "${ASC_KEY_ID:-}" ]]; then
  auth+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
version=()
if [[ -n "${MARKETING_VERSION:-}" ]]; then
  version=(MARKETING_VERSION="$MARKETING_VERSION")
fi

xcodegen generate --quiet
rm -rf "$out"
mkdir -p "$out"
xcodebuild -quiet -project AICodingTool.xcodeproj -scheme AICodingTool -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/AICodingTool.xcarchive" CURRENT_PROJECT_VERSION="$build" "${version[@]}" CODE_SIGNING_ALLOWED=NO archive

# Writes the export options for one destination: "export" leaves an IPA here, "upload" sends it to App Store Connect.
export_options() {
  cat > "$out/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>teamID</key><string>T3Y739SK63</string>
$(if [[ -n "${IOS_PROFILE_UUID:-}" ]]; then cat <<MANUAL
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict><key>com.zyuapp.aicodingtool.phone</key><string>$IOS_PROFILE_UUID</string></dict>
MANUAL
else echo '  <key>signingStyle</key><string>automatic</string>'; fi)
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
}

# The signed app is checked before anything is uploaded: a build without the push entitlement never
# receives a notification, and nothing else would say so.
export_options export
xcodebuild -quiet -exportArchive -archivePath "$out/AICodingTool.xcarchive" -exportOptionsPlist "$out/ExportOptions-export.plist" -exportPath "$out/export" "${auth[@]}"
rm -rf "$out/check"
ditto -x -k "$out/export/AICodingTool.ipa" "$out/check"
aps=$(codesign -d --entitlements - --xml "$out/check/Payload/AICodingTool.app" 2>/dev/null | plutil -extract aps-environment raw - 2>/dev/null || true)
rm -rf "$out/check"
if [[ "$aps" != "production" ]]; then
  echo "error: the exported app is not entitled to production push notifications (aps-environment: ${aps:-missing})." >&2
  exit 1
fi
if [[ "${TESTFLIGHT_DESTINATION:-upload}" == "upload" ]]; then
  export_options upload
  xcodebuild -quiet -exportArchive -archivePath "$out/AICodingTool.xcarchive" -exportOptionsPlist "$out/ExportOptions-upload.plist" -exportPath "$out/upload" "${auth[@]}"
fi
echo "Exported build $build (${TESTFLIGHT_DESTINATION:-upload})."
