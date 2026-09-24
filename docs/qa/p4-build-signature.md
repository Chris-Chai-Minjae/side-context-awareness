# Compiled daemon launch check

On macOS 27.0.0 arm64 with Bun 1.3.5, the old `bun run build` exited 0, but `codesign --verify --strict dist/side-daemon` reported `invalid signature (code or signature have been modified)`, and `./dist/side-daemon help` exited 137. Running `codesign --force --sign - dist/side-daemon` made verification and `help` pass. The `build` script now performs that same ad-hoc signing step after compilation. This signs only the local build artifact; Developer ID signing and notarization remain P5-T5.2.

After the change, `bun run build && codesign --verify --strict --verbose=2 dist/side-daemon && ./dist/side-daemon help` exited 0 and printed the CLI command list. `bun test` passed 696 tests, `npx tsc --noEmit` and `npx biome check .` passed, and Swift tests passed 136 SideCaptureKit plus 10 SideApp cases. This proves local executable launch, not clean-Mac packaging or TCC operation.
