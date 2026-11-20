# gma3-mcp

An [MCP](https://modelcontextprotocol.io) server for grandMA3 onPC. Inspect show data, program
fixtures, build cues and recipes, control playback, and retrieve source-linked documentation.
This is a fork of [bdstark/gma3-mcp](https://github.com/bdstark/gma3-mcp).

## Install with an assistant

Copy this into Claude or ChatGPT with local computer access:

```text
Set up https://github.com/nf-s/gma3-mcp on the computer running my grandMA3 onPC.
Clone or safely update the fork, use Node.js 24+ to run npm ci and npm run build, and
configure my ChatGPT or Claude client to launch it. For a new setup, set
GMA3_DOCS_URL=https://ma3-docs.pages.dev in the MCP server environment. Preserve any
existing local docs setting. Verify a manual
lookup, then reuse or help me start the onPC bridge and check the connection with gma3_status.
```

The snippet uses the [hosted docs](https://ma3-docs.pages.dev). The client starts the MCP server when it connects. If your chat lacks local computer access,
it can walk you through the same steps. [Detailed setup prompt](docs/setup/ai-setup-prompt.md)

## Manual setup

Install grandMA3 onPC, Git and Node.js 24 or newer. Build the server in a terminal.

```sh
git clone https://github.com/nf-s/gma3-mcp.git
cd gma3-mcp
npm ci
npm run build
```

On Windows PowerShell, use `npm.cmd`. Follow the platform guide to copy the plugin files,
import the bridge into a free Plugin slot, start it and configure your MCP client.

| Connection | Guide |
| --- | --- |
| macOS | [Install and connect](docs/setup/macos.md) |
| Windows | [Install and connect](docs/setup/windows.md) |
| ChatGPT web | [Tunnel setup and access requirements](docs/setup/chatgpt-web.md) |
| Different computers | [SSH access](docs/remote-access.md) |
| Optional container | [Docker](docs/docker.md) |

Claude Code and Claude Desktop use stdio MCP configuration. ChatGPT desktop supports local
stdio configuration. ChatGPT web needs a supported tunnel connection and workspace access.
A local path or the bridge's TCP address is not a web MCP URL.

## Check the connection

1. Ask your assistant to search the manual for **Store**, open the matching keyword page and
   return a source link and the publication version. You can do this before starting onPC.
   For a local index or the installed manual, see [documentation settings](docs/tools/docs.md).
2. With the bridge running, ask it to call `gma3_status` and report the connected show and
   onPC version. If that fails, run `node scripts/bridge-cli.mjs ping` on the server computer
   to check whether the bridge itself answers. [Bridge troubleshooting](docs/setup/bridge.md)

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
MA Lighting documentation and libraries are not bundled in this repository. Documentation
is retrieved from your installed manual or a separately managed service. The plugin uses
LuaSocket and JSON libraries supplied with onPC.
