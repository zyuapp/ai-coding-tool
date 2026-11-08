// swift-tools-version: 6.0
import PackageDescription

// The app's protocol, client state machine and domain logic, built for the Mac so `swift test` can
// check them without a simulator. The app itself is built from project.yml.
let package = Package(
    name: "AICodingTool",
    platforms: [.macOS(.v15), .iOS(.v18)],
    targets: [
        .target(
            name: "AICodingTool",
            path: "AICodingTool",
            exclude: ["App", "UI", "Resources", "Client/PhoneConnection.swift"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AICodingToolTests",
            dependencies: ["AICodingTool"],
            path: "AICodingToolTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
