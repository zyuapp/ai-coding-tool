#!/bin/zsh
# Archives the app and uploads it to TestFlight, signed and sent through the Apple ID signed in to
# Xcode. The archive is built unsigned because automatic signing would ask for a development
# profile, which needs a registered device; the export signs it for the App Store instead. Each
# upload gets a fresh build number, which is what TestFlight orders builds by.
set -euo pipefail
cd "${0:A:h}"

build=$(date -u +%Y%m%d%H%M)
out=build/testflight

xcodegen generate --quiet
rm -rf "$out"
mkdir -p "$out"
xcodebuild -quiet -project AICodingTool.xcodeproj -scheme AICodingTool -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/AICodingTool.xcarchive" CURRENT_PROJECT_VERSION="$build" CODE_SIGNING_ALLOWED=NO archive
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${TESTFLIGHT_DESTINATION:-upload}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>T3Y739SK63</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
xcodebuild -quiet -exportArchive -archivePath "$out/AICodingTool.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/export" -allowProvisioningUpdates
echo "Uploaded build $build. It appears in TestFlight once App Store Connect finishes processing it."
