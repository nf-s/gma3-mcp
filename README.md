# gma3-mcp

An [MCP](https://modelcontextprotocol.io) server for grandMA3 onPC. Inspect show data, program
fixtures, build cues and recipes, control playback, and retrieve source-linked documentation.
This is a fork of [bdstark/gma3-mcp](https://github.com/bdstark/gma3-mcp).

## Install with an assistant

Copy this into Claude or ChatGPT with local computer access:

```text
Set up grandMA3 MCP on my computer. Run docker pull ghcr.io/nf-s/gma3-mcp:latest,
then follow https://github.com/nf-s/gma3-mcp/blob/main/docs/docker.md to connect the
image to my ChatGPT or Claude client. Verify offline documentation search by looking
up the Store keyword. Reuse my running onPC bridge or help me install the plugin from
the image. Check the connection with gma3_status and preserve my existing settings.
```

The client launches the container. A chat without local computer access can guide you through
installation. Use the [detailed setup prompt](docs/setup/ai-setup-prompt.md) or the
[Docker guide](docs/docker.md) for exact macOS/Windows plugin-copy and client commands.
Install Docker and grandMA3 onPC on the host. Your client may ask you to approve the connection.

## Setup options and checks

Existing native deployments can stay in use. Source installations require Git and Node.js 24+. Follow [macOS](docs/setup/macos.md) or [Windows](docs/setup/windows.md).
For separate computers use [SSH](docs/remote-access.md). [ChatGPT web](docs/setup/chatgpt-web.md)
needs a supported tunnel and workspace access.

1. Through your actual client, search for **Store**, retrieve the matching page and references,
   and check source links and version provenance. This works before importing the bridge.
2. With the bridge running, call `gma3_status` and confirm the expected show, onPC version,
   data pool and build state. The [Docker guide](docs/docker.md) covers reaching
   the bridge's loopback-only listener. [Bridge troubleshooting](docs/setup/bridge.md)

## Show workflows

Structured tools check targets before changes and normally read back the result. They report
command dispatch separately from verified state. After a timeout, inspect the console before
trying again. A dispatched command can still complete.

| Task | Examples |
| --- | --- |
| Inspect | Read fixtures, pools, cues, executors, programmer values, output and references |
| Program | Patch fixtures, place them in 3D, build selection grids, groups and presets |
| Build playback | Store cues, recipes, phasers, chases, macros and timecode, and assign executors |
| Operate | Control sequences and faders, manage speed masters, save and load shows |
| Reference | Search installed or indexed documentation and inspect live Lua API descriptions |

> Build a cue list from these groups and presets, with named cues and explicit fades, and put
> it on a free executor. Check the assignment and stored cue contents.

> Create a dimmer phaser across this group's selection grid, store it as a preset and read
> back its steps. Ask before auditioning it.

See the [tool index](docs/tools/README.md) and [configuration reference](docs/reference.md)
for supported parameters, verification and limitations.

## Console connection and testing

```text
MCP client → stdio → local Node.js server → loopback TCP bridge → grandMA3 onPC
```

The Lua plugin runs inside onPC and listens on `127.0.0.1:9800`. Import it into the show and
start it after each show load. Both server and bridge are needed for console tools. The bridge
has no authentication and accepts loopback connections only. Use the SSH guide for remote use.

Tools act on the live show. Start with read-only checks and a disposable show for experiments.
Arbitrary Lua and console input are opt-in and disabled by default. See [Lua policy](docs/lua.md)
and [input tools](docs/tools/input.md) before enabling them.

The documented live baseline is macOS onPC 2.5.1.0. Setup instructions for another platform do
not establish equivalent live validation. The [compatibility matrix](docs/compatibility.md)
distinguishes live probes, automated checks and unqualified combinations.

For development, run `npm run build` and `npm test`. Follow the [development guide](docs/development.md)
and [live-test procedure](test/live/README.md). Live tests require a disposable show and are
separate from routine installation checks.

## Contributing and license

See [contributing](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md),
[accessibility guidance](ACCESSIBILITY.md) and the [security policy](SECURITY.md).

[MIT](LICENSE). grandMA3 and MA Lighting are trademarks of MA Lighting Technology GmbH.
This independent project is not affiliated with, endorsed by or supported by MA Lighting.
Documentation results retain MA source credits and publication provenance. The plugin uses
LuaSocket and JSON libraries supplied with onPC.
