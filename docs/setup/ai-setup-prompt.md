# AI-assisted setup

[README](../../README.md) · [Docker](../docker.md) · [macOS](macos.md) · [Windows](windows.md)

Copy this into Claude or ChatGPT. Local installation requires local computer tools;
otherwise the assistant can guide you. Initial onPC import and client approvals may need you.

```text
Install https://github.com/nf-s/gma3-mcp on my actual computer using the published Docker
image ghcr.io/nf-s/gma3-mcp:latest. Perform available steps and guide required user actions.

Establish my OS, client, Docker availability and whether onPC runs here. Read the repository's
Docker, platform and bridge guides. Preserve working custom MCP, bridge and local docs
configurations; this request does not authorise replacing them. Keep personal paths and
credentials out of shared files. New installs need Docker and onPC, without host Git, Node.js
or npm. Pull the image explicitly with docker pull ghcr.io/nf-s/gma3-mcp:latest.

Configure my client's local stdio server to run the image using the Docker guide's arguments.
Merge configuration and preserve other servers. Claude Code uses .mcp.json; Claude Desktop
uses claude_desktop_config.json. ChatGPT desktop uses MCP settings or Codex config.toml.
The client launches the container; do not use detached mode or a TTY. Follow actual client
approval/restart requirements. ChatGPT web needs its documented supported tunnel and workspace
access; local configuration and bridge TCP are not web MCP URLs.

The image provides offline documentation search. No docs import,
index build or docs environment override is needed. Before bridge import, verify
gma3_docs_search, gma3_docs_get and gma3_docs_reference using returned IDs. Check source links,
authority and version provenance, and test gma3_help.

Check for an existing bridge first through gma3_status. If installation is needed, extract
all plugin files from /app/plugin using docker create, docker cp and docker rm as documented.
Copy the XML and every referenced Lua component into the actual onPC resource library.
Have me identify a free Plugin slot, then guide import/start inside my already-open onPC
session. File copying alone does not import the plugin. Preserve existing plugins and follow
the update guide for replacements.

Use the image's default host.docker.internal bridge route on Docker Desktop. Check actual
reachability; use host networking only as a supported, explicitly enabled fallback and check
for a local docs port 8765 conflict. Verify gma3_status through my actual client and confirm the expected show,
version, data pool and build state. Preserve custom ports. Use the SSH guide for separate
computers. Leave Lua, input and OSC disabled. Report passed checks and remaining user actions.
```
