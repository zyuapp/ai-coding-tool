#!/bin/zsh
# Archives the app and uploads it to TestFlight with an App Store Connect API key. Each upload gets a
# fresh build number, which is what TestFlight orders builds by.
set -euo pipefail
cd "${0:A:h}"

key_id=${ASC_KEY_ID:-GXT3CH3PMJ}
issuer=${ASC_ISSUER_ID:-434ddf21-d8e9-434d-85b2-590c9d3c2df7}
key_path=${ASC_KEY_PATH:-"$HOME/Apple Developer/AuthKey_$key_id.p8"}
build=$(date -u +%Y%m%d%H%M)
out=build/testflight
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key_path" -authenticationKeyID "$key_id" -authenticationKeyIssuerID "$issuer")

xcodegen generate --quiet
rm -rf "$out"
xcodebuild -project AICodingTool.xcodeproj -scheme AICodingTool -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/AICodingTool.xcarchive" CURRENT_PROJECT_VERSION="$build" "${auth[@]}" archive
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>T3Y739SK63</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/AICodingTool.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/export" "${auth[@]}"
echo "Uploaded build $build. It appears in TestFlight once App Store Connect finishes processing it."
