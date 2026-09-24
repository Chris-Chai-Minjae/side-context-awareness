import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startApiServer } from "../../src/api/server"

test("P4-S0-T1: authenticated web load serves bundled UI without subresource requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-web-"))
  const webDirectory = join(directory, "web")
  mkdirSync(webDirectory)
  writeFileSync(
    join(webDirectory, "index.html"),
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'" /><link rel="stylesheet" crossorigin href="./app.css"><script type="module" crossorigin src="./app.js"></script></head><body><div id="app"></div></body></html>',
  )
  writeFileSync(join(webDirectory, "app.css"), "body { color: red; }")
  writeFileSync(join(webDirectory, "app.js"), 'window.sideLoaded = "$&"; console.log("</script>")')
  const executablePath = '/Applications/Side & Friends.app/Contents/Resources/side"<test>'
  const server = await startApiServer({
    directory,
    webDirectory,
    webExecutablePath: executablePath,
    handlers: {},
  })
  try {
    const url = `http://127.0.0.1:${server.port}/?t=synthetic-token`
    expect((await fetch(url)).status).toBe(401)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${server.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const csp = response.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("script-src 'nonce-")
    expect(csp).toContain("connect-src 'self'")
    const html = await response.text()
    expect(html).toContain("body { color: red; }")
    expect(html).toContain('window.sideLoaded = "$&"')
    expect(html).not.toContain('src="./app.js"')
    expect(html).not.toContain('href="./app.css"')
    expect(html).not.toContain("synthetic-token")
    expect(html).not.toContain('console.log("</script>")')
    expect(html).toContain(
      '<meta name="side-executable" content="/Applications/Side &amp; Friends.app/Contents/Resources/side&quot;&lt;test&gt;">',
    )
    expect(
      (
        await fetch(`http://127.0.0.1:${server.port}/app.js`, {
          headers: { Authorization: `Bearer ${server.token}` },
        })
      ).status,
    ).toBe(404)
  } finally {
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
