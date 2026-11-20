# Docker setup

[README](../README.md) · [macOS](setup/macos.md) · [Windows](setup/windows.md) · [Bridge](setup/bridge.md)

The published image runs the Node.js MCP server. New installations need Docker and grandMA3
onPC, without Git, Node.js or npm on the host. The bridge still runs inside onPC. Preserve a
working custom MCP configuration, bridge and explicitly configured local documentation service.

Offline documentation search starts automatically; no documentation import, index build or
environment override is needed. Documentation lookups work before onPC or its bridge is running.

## Pull and configure

```sh
docker pull ghcr.io/nf-s/gma3-mcp:latest
```

On macOS/Windows use Docker Desktop. Configure your client to launch this stdio server;
do not add `-t` or run it detached:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "ghcr.io/nf-s/gma3-mcp:latest"]
    }
  }
}
```

This JSON is for Claude Code/Desktop. Merge only `gma3` and preserve other servers. In ChatGPT
desktop's STDIO form use `docker` as the command and the same individual arguments; Codex TOML
uses `command` and `args` under `[mcp_servers.gma3]`. Use Docker's absolute executable path if
it is absent from the client's PATH. Restart the MCP client/server after configuration changes.

The image uses `host.docker.internal` to reach the host bridge. This reached a loopback-only
listener in a macOS Docker Desktop check; verify your actual console path with `gma3_status`.
If it fails, use the [native setup](setup/macos.md) ([Windows](setup/windows.md)) or
[SSH arrangement](remote-access.md). Never rebind or publicly relay the raw bridge.

Host networking is an optional fallback only where explicitly supported and enabled. It needs
`--network host` and `-e GMA3_BRIDGE_HOST=127.0.0.1`; it did not work in the desktop check.
The image's local docs server also binds port 8765, so host-network mode can conflict with an
existing local docs service on that port. To intentionally reuse that service in host-network
mode, add `-e GMA3_DOCS_LOCAL=0 -e GMA3_DOCS_URL=http://127.0.0.1:8765` to disable the
second server. Linux is an MCP host, not an onPC platform.

Preserve an existing native local docs deployment rather than replacing it automatically.
Container `127.0.0.1` refers to the image's own docs service, not the host's service; moving
an existing deployment into Docker requires a separately verified reachability configuration.
Preserve any custom bridge port with `-e GMA3_BRIDGE_PORT=PORT`.

## Copy the bridge to the host

Check whether an existing bridge works before importing another. If installation is needed,
launch onPC once and locate its resource library. The commands below extract the plugin from
the same image; they do not start it. Use a free temporary container name if this one exists.

macOS Terminal, for the default library:

```sh
docker create --name gma3-plugin-copy ghcr.io/nf-s/gma3-mcp:latest
docker cp gma3-plugin-copy:/app/plugin ./gma3-mcp-plugin
docker rm gma3-plugin-copy
mkdir -p "$HOME/MALightingTechnology/gma3_library/datapools/plugins"
cp ./gma3-mcp-plugin/gma3_mcp_*.lua ./gma3-mcp-plugin/gma3_mcp_bridge.xml "$HOME/MALightingTechnology/gma3_library/datapools/plugins/"
```

Windows PowerShell, for the default library:

```powershell
docker create --name gma3-plugin-copy ghcr.io/nf-s/gma3-mcp:latest
docker cp gma3-plugin-copy:/app/plugin ./gma3-mcp-plugin
docker rm gma3-plugin-copy
$pluginDirectory = Join-Path $env:ProgramData 'MALightingTechnology\gma3_library\datapools\plugins'
New-Item -ItemType Directory -Force -Path $pluginDirectory | Out-Null
Copy-Item ./gma3-mcp-plugin/gma3_mcp_*.lua, ./gma3-mcp-plugin/gma3_mcp_bridge.xml -Destination $pluginDirectory
```

Use a new extraction directory if `gma3-mcp-plugin` already exists. Substitute your actual
library location if customised. These copy commands update matching library files; they do
not replace an imported Plugin pool object. Follow the [bridge update procedure](setup/bridge.md)
for an existing installation.

In the **onPC command line**, with Admin or Setup rights, replace `FREE_SLOT` with a verified
empty Plugin pool slot:

```text
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin FREE_SLOT
Plugin "gma3_mcp_bridge"
```

Check the listening and successful module-startup messages. Save from onPC if you want to
retain the import. Start the bridge after every show load. Initial import and client approvals
may require the operator; copying files alone does not complete them.

## Verify

First use the actual MCP client to call `gma3_docs_search`, retrieve a returned ID with
`gma3_docs_get` and its canonical reference with `gma3_docs_reference`. Check source links,
authority and version. These tools do not require the console bridge.

Then call `gma3_status` and confirm the expected show, version, data pool, bridge and fresh
server build. This verifies the container-to-console path. A process that starts successfully
does not prove that path works. Leave Lua, input and OSC disabled during setup.

To update, pull the image again and restart the MCP server. Check whether the bundled bridge
also needs the documented update procedure. Source builds use the Dockerfile's offline target
with a separately prepared corpus context; the published image is already indexed. See [compatibility](compatibility.md) for tested scope.

## Local viewer

To open the same offline reference in a browser, run a separate container. Set
`MA3_DOCS_PASSWORD` privately in your shell to a password of at least 16 characters first:

```sh
docker run --rm -p 127.0.0.1:8766:8765 -e MA3_DOCS_PASSWORD ghcr.io/nf-s/gma3-mcp:latest docs --host 0.0.0.0
```

Open [the local viewer](http://127.0.0.1:8766), username `ma3`, using that password.
Authentication is required for the server to listen beyond container loopback. The normal MCP
container needs no published docs port or viewer password.

## Maintainer image builds

From a source checkout, prepare a reviewed corpus context and build the offline target:

```sh
corpus_parent=$(mktemp -d)
corpus_parent=$(cd "$corpus_parent" && pwd -P)
python3 scripts/package-docker-corpus.py /path/to/ma3-docs "$corpus_parent/corpus"
docker build --target offline --build-context corpus="$corpus_parent/corpus" -t gma3-mcp:offline .
```

The packager strips absolute source paths and captured console metadata, excludes private live
supplements and caches, and rejects symbolic links. Review source content before sharing; the
scan does not replace review. The build creates the image's index and does not upload anything.
Use `gma3-mcp:offline` in place of the registry tag to run your build.

For import/rebuild tools, `docker run … IMAGE import` runs the bundled pipeline. Mount writable
generated directories and source publications according to the
[reference application's instructions](https://github.com/nf-s/ma3-docs#build-the-local-index).
These maintainer steps are unnecessary when using the published image.
