# Source-only distribution decision — 2026-09-24

## User decision and boundary

The user chose to publish Side's source on GitHub so each user can build `Side.app` locally. A paid Apple Developer Program membership and Developer ID identity are not required for this source-only route. The local build is ad hoc signed. This decision does not satisfy the approved P5-T5.2 acceptance criterion for a prebuilt, notarized ZIP; its checkbox and the corresponding release gate remain open. The approved planning documents and specs have not been changed.

The user selected the MIT License; `LICENSE` uses the 2026 `Side contributors` copyright holder. This is a source publication choice, not evidence that any third-party component may be copied into the repository.

`README.md` now gives the `/Applications/Side.app` install command and explains that replacing an ad hoc signed build can require re-adding the app in macOS privacy settings. No GitHub remote was configured and no code was pushed during this decision.

## Live local evidence

- The installed `/Applications/Side.app/Contents/Resources/side status` returned `Side: running (enabled)`.
- The local `historyStatus` RPC returned one `done`, one `running`, and zero `failed` summary jobs for today. It also listed today in `days_with_summaries`.
- A metadata-only query of Side's own ledger grouped summary rows by `model` and `status`: one `done` row used `Xiaomi MiMo 2.6 Pro (Singapore Token Plan)/mimo-v2.6-pro`; the running row had no model recorded yet.
- `/Applications/Side.app/Contents/Resources/side doctor` exited 0 with PASS for Keychain, permissions, custom SQLite, vec0, model cache, and provider connection on this Mac. The provider check uses synthetic text.

No capture body, summary text, title, URL, API key, or Aside ledger row was read for these checks. This proves one successful MiMo summary and a passing doctor run on the current Mac; it does not prove the MiniMax fallback, Homebrew-free clean-Mac installation, long-duration capture, or notarized distribution.

## Third-party distribution boundary

A read-only package and build-script audit found that `build-app.sh` bundles a compiled Bun executable, native libraries, and a downloaded MiniLM model without copying third-party notices into `Side.app`. This does not affect the chosen source-only GitHub route, where each user builds the app locally. It does mean a prebuilt app should not be redistributed until its actual binary contents and notices have been reviewed. In particular, the exact Bun 1.3.5 LGPL relinking obligations and the converted Xenova model license/revision remain unverified; no compliance claim is made for a binary release. See the upstream [Bun license](https://github.com/oven-sh/bun/blob/main/LICENSE.md), [ONNX Runtime notices](https://github.com/microsoft/onnxruntime/blob/v1.30.0/ThirdPartyNotices.txt), and [Xenova model page](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2).
