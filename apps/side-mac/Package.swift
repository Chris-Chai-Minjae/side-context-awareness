// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "SideCaptureKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SideCaptureKit", targets: ["SideCaptureKit"]),
        .executable(name: "Side", targets: ["Side"]),
    ],
    targets: [
        .target(name: "SideCaptureKit", resources: [.process("Resources")]),
        .executableTarget(name: "Side", dependencies: ["SideCaptureKit"]),
        .testTarget(name: "SideCaptureKitTests", dependencies: ["SideCaptureKit", "Side"]),
        .testTarget(name: "SideAppTests", dependencies: ["Side"]),
    ]
)
