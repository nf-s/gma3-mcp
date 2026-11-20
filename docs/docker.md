# Docker

The image contains the MCP server and the MA3 Reference viewer/API and import tools.
The default setup below uses hosted reference search; no imported publications are included.
The Lua bridge still runs inside grandMA3 onPC. [Platform setup](setup/macos.md)

## Build and connect

```sh
docker build -t gma3-mcp:docs .
```

Configure your MCP client:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--add-host=host.docker.internal:host-gateway", "-e", "GMA3_DOCS_URL=https://ma3-docs.pages.dev", "gma3-mcp:docs"]
    }
  }
}
```

The example explicitly sets `GMA3_DOCS_URL=https://ma3-docs.pages.dev`. This enables read-only, source-linked documentation
search over the network. It does not send console commands or show data to the documentation service.
Omit that setting to use only the installed manual, mounted read-only at `/gma3`.
The image pins the reference application source to a public commit; it never copies a local checkout,
cache, credential file or deployment record into the default build.

`host.docker.internal` does not always reach a host's loopback-only bridge. Check `gma3_status`.
Use native MCP or supported Docker host networking if needed; never publicly relay the bridge.
On Linux with a [local SSH tunnel](remote-access.md), use `--network host` and
`-e GMA3_BRIDGE_HOST=127.0.0.1 -e GMA3_OSC_HOST=127.0.0.1`.

## Local image with imported documentation

Use Docker with BuildKit and named build contexts (Docker Buildx).
Only build this target with publications you are allowed to use. The packaging command takes an
existing MA3 Reference directory and makes a separate corpus context. It includes manual and release
records, articles, illustrations and PDFs; removes absolute user source paths and captured console
metadata; and excludes guides, live console captures and all caches. The image rebuilds its own index. Packaging rejects symbolic links and uses an atomic destination;
its common-pattern scan is a safeguard, not a complete privacy review. Review the source before sharing.
The manual Lua reference remains included; private live Lua supplements are excluded.

```sh
corpus_parent=$(mktemp -d)
corpus_parent=$(cd "$corpus_parent" && pwd -P)
python3 scripts/package-docker-corpus.py /path/to/ma3-docs "$corpus_parent/corpus"
docker build --target offline --build-context corpus="$corpus_parent/corpus" -t gma3-mcp:offline .
```

Replace the complete `args` array with the following; omit the hosted URL setting:

```json
["run", "-i", "--rm", "--add-host=host.docker.internal:host-gateway", "gma3-mcp:offline"]
```

Its local reference server starts with MCP and
uses container loopback, so documentation works without network access. The normal bridge connection
still needs networking. Keep a populated image local unless you have permission to redistribute every
included publication. Neither build command uploads or deploys the image.

Run the bundled viewer on a separate host port:

```sh
# Set MA3_DOCS_PASSWORD in your shell to a password of at least 16 characters.
docker run --rm -p 127.0.0.1:8766:8765 -e MA3_DOCS_PASSWORD gma3-mcp:offline docs --host 0.0.0.0
```

Open [the viewer](http://127.0.0.1:8766), username `ma3`, with that password.
The server requires authentication when listening beyond container loopback. MCP's internal server
needs no published port and normally uses no authentication environment settings.

## Mounted corpus and import tools

The default image can also use an external prebuilt corpus. Mount the prepared directories under
`/opt/ma3-docs/data`, `/opt/ma3-docs/content`, `/opt/ma3-docs/assets` and
`/opt/ma3-docs/release-notes-pdf` read-only; pass `-e GMA3_DOCS_LOCAL=1` and
`-e GMA3_DOCS_URL=http://127.0.0.1:8765`. The server creates its index in the container's writable
`/opt/ma3-docs/.cache`; no host cache is needed.

Python, lxml, PDF libraries and Poppler are installed. `docker run … gma3-mcp:docs import` runs
the bundled import pipeline. Mount writable generated directories and source publications as described
in the [reference application's instructions](https://github.com/nf-s/ma3-docs#build-the-local-index).
The `docs` command also works on the default image, displaying an empty index until imports are supplied.
