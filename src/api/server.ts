import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  API_MAX_REQUEST_BYTES,
  API_TOKEN_BYTES,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from "../constants"
import { createWebToken, tcpAuthStatus } from "./auth"
import { handleRpcBody, type RpcHandlers } from "./rpc"

export type ApiServer = {
  readonly port: number
  readonly socketPath: string
  readonly token: string
  readonly stop: () => Promise<void>
}

export type ApiServerOptions = {
  readonly directory: string
  readonly handlers: RpcHandlers
  readonly webDirectory?: string
  readonly webExecutablePath?: string
}

const WEB_SCRIPT_RE = /<script type="module" crossorigin src="\.\/([A-Za-z0-9_-]+\.js)"><\/script>/u
const WEB_STYLE_RE = /<link rel="stylesheet" crossorigin href="\.\/([A-Za-z0-9_-]+\.css)">/u

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

async function serveWeb(directory: string, executablePath?: string): Promise<Response> {
  try {
    let html = await readFile(join(directory, "index.html"), "utf8")
    const scriptName = WEB_SCRIPT_RE.exec(html)?.[1]
    const styleName = WEB_STYLE_RE.exec(html)?.[1]
    if (!scriptName || !styleName) return new Response(null, { status: 503 })
    const [script, style] = await Promise.all([
      readFile(join(directory, scriptName), "utf8"),
      readFile(join(directory, styleName), "utf8"),
    ])
    const nonce = randomBytes(API_TOKEN_BYTES).toString("base64")
    html = html
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/u, "")
      .replace("</head>", () =>
        executablePath
          ? `<meta name="side-executable" content="${htmlAttribute(executablePath)}"></head>`
          : "</head>",
      )
      .replace(WEB_STYLE_RE, () => `<style>${style.replace(/<\/style/giu, "<\\/style")}</style>`)
      .replace(
        WEB_SCRIPT_RE,
        () =>
          `<script type="module" nonce="${nonce}">${script.replace(/<\/script/giu, "<\\/script")}</script>`,
      )
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'`,
      },
    })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return new Response(null, { status: 503 })
    throw error
  }
}

async function serveRpc(request: Request, handlers: RpcHandlers): Promise<Response> {
  if (new URL(request.url).pathname !== "/rpc") return new Response(null, { status: 404 })
  if (request.method !== "POST") return new Response(null, { status: 405 })
  const body = await request.text()
  if (Buffer.byteLength(body) > API_MAX_REQUEST_BYTES) return new Response(null, { status: 413 })
  const payload = await handleRpcBody(body, handlers)
  if (payload === null) return new Response(null, { status: 204 })
  return Response.json(payload)
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const runDirectory = join(options.directory, "run")
  await mkdir(runDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runDirectory, PRIVATE_DIRECTORY_MODE)

  const socketPath = join(runDirectory, "daemon.sock")
  const webPath = join(runDirectory, "web.json")
  const { token, tokenHash } = createWebToken()
  const temporaryPath = join(runDirectory, `web.${tokenHash}.tmp`)
  let uds: Bun.Server<undefined> | undefined
  let tcp: Bun.Server<undefined> | undefined
  let webPublished = false
  try {
    uds = Bun.serve({
      unix: socketPath,
      maxRequestBodySize: API_MAX_REQUEST_BYTES,
      fetch: (request) => serveRpc(request, options.handlers),
    })
    await chmod(socketPath, PRIVATE_FILE_MODE)
    tcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: API_MAX_REQUEST_BYTES,
      fetch: (request, server) => {
        if (server.port === undefined) return new Response(null, { status: 503 })
        const status = tcpAuthStatus(request, server.port, tokenHash)
        if (status !== null) return new Response(null, { status })
        const path = new URL(request.url).pathname
        if (path === "/" || path === "/index.html") {
          if (request.method !== "GET") return new Response(null, { status: 405 })
          return options.webDirectory
            ? serveWeb(options.webDirectory, options.webExecutablePath)
            : new Response(null, { status: 404 })
        }
        return serveRpc(request, options.handlers)
      },
    })
    const port = tcp.port
    if (port === undefined) throw new TypeError("TCP listener has no port")
    await writeFile(temporaryPath, JSON.stringify({ port, tokenHash }), {
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    })
    await chmod(temporaryPath, PRIVATE_FILE_MODE)
    await rename(temporaryPath, webPath)
    webPublished = true
    await chmod(webPath, PRIVATE_FILE_MODE)

    const activeUds = uds
    const activeTcp = tcp
    return {
      port,
      socketPath,
      token,
      async stop() {
        await Promise.all([activeTcp.stop(true), activeUds.stop(true)])
        await Promise.all([rm(webPath, { force: true }), rm(socketPath, { force: true })])
      },
    }
  } catch (error) {
    await Promise.all([tcp?.stop(true), uds?.stop(true)])
    await rm(temporaryPath, { force: true })
    if (webPublished) await rm(webPath, { force: true })
    if (uds) await rm(socketPath, { force: true })
    throw error
  }
}
