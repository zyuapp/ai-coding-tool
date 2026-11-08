// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "aic-dictation",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.12.6"),
    ],
    targets: [
        .executableTarget(
            name: "aic-dictation",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/aic-dictation"
        ),
    ]
)
