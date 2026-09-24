import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const [entryArg, outputArg] = process.argv.slice(2)
if (!entryArg || !outputArg) throw new TypeError("Expected entrypoint and output path")
if (process.platform !== "darwin") throw new TypeError("Side.app builds require macOS")

const entrypoint = resolve(entryArg)
const output = resolve(outputArg)
const nativeDir = join(
  dirname(import.meta.dir),
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v6",
  "darwin",
  process.arch,
)
const stage = mkdtempSync(join(tmpdir(), "side-onnx-addon-"))
const addon = join(stage, "onnxruntime_binding.node")

try {
  copyFileSync(join(nativeDir, "onnxruntime_binding.node"), addon)
  const patched = Bun.spawnSync({
    cmd: [
      "install_name_tool",
      "-change",
      "@rpath/libonnxruntime.1.dylib",
      "@executable_path/lib/libonnxruntime.1.dylib",
      addon,
    ],
  })
  if (patched.exitCode !== 0) throw new Error(patched.stderr.toString())
  const signed = Bun.spawnSync({ cmd: ["codesign", "--force", "--sign", "-", addon] })
  if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())

  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: { outfile: output },
    plugins: [
      {
        name: "side-text-only-native",
        setup(build) {
          build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "side-text" }))
          build.onLoad({ filter: /^sharp$/, namespace: "side-text" }, () => ({
            contents:
              'export default function sharp() { throw new Error("Image processing is unavailable") }',
            loader: "js",
          }))
          build.onLoad(
            { filter: /@huggingface\/transformers\/dist\/transformers\.node\.mjs$/ },
            (args) => {
              const source = readFileSync(args.path, "utf8")
              const original = 'requireFromHere("onnxruntime-node")'
              if (!source.includes(original))
                throw new Error("Transformers ONNX import layout changed")
              return {
                contents: source.replace(original, 'require("onnxruntime-node")'),
                loader: "js",
              }
            },
          )
          build.onLoad({ filter: /onnxruntime-node\/dist\/binding\.js$/ }, (args) => {
            const source = readFileSync(args.path, "utf8")
            const original = `require(\`../bin/napi-v6/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`)`
            if (!source.includes(original)) throw new Error("ONNX native binding layout changed")
            return {
              contents: source.replace(original, `require(${JSON.stringify(addon)})`),
              loader: "js",
            }
          })
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"))
} finally {
  rmSync(stage, { recursive: true, force: true })
}
