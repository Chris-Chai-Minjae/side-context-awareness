# P4-S3-V / P4-S4-V native screen field coverage

`tests/contracts/rpc.test.ts` now reads all four approved screen YAML files. For each `data_requirements[].needs` field it checks the matching RPC output schema in `RpcResourceFieldSchemas`.

Command: `bun test tests/contracts/rpc.test.ts` → **4 pass, 0 fail, 179 assertions**. This covers `capture_status` for `menubar.yaml` and `permissions` plus `settings` for `onboarding.yaml` as well as the two web screens.

This is schema coverage only. It does not prove that a live Side.app consumes those responses or that TCC permissions change. The parent P4-S3-V and P4-S4-V tasks remain open; their other connection and native observation gates retain their separate evidence requirements.
