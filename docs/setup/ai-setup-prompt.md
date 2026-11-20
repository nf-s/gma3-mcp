# AI-assisted setup

[README](../../README.md) · [macOS](macos.md) · [Windows](windows.md) · [ChatGPT web](chatgpt-web.md)

Copy this prompt into Claude or ChatGPT. Installation requires local terminal and file access;
otherwise the assistant can provide instructions. Client approvals, restarts and initial onPC
import may require your action.

```text
Install https://github.com/nf-s/gma3-mcp and connect it to grandMA3 onPC with documentation
search. Perform available steps and give exact instructions for actions requiring me.

Establish my OS, client, local tools and whether onPC runs on this computer. Read the
repository's README, applicable AGENTS.md, platform setup, bridge and indexed-documentation
guides. Keep credentials and personal paths out of shared files and reports.

Use a suitable existing checkout, inspecting edits and branch first; fast-forward only
when safe. Otherwise clone the public fork. Check Git, onPC and Node.js 24+, then run npm ci
and npm run build (npm.cmd on Windows).

Configure gma3 as a stdio MCP server using absolute Node and dist/index.js paths. The client
launches it. Back up configuration and preserve other entries. Claude Code uses .mcp.json;
Claude Desktop uses claude_desktop_config.json. Print the repository's configuration
rather than overwriting existing JSON. ChatGPT desktop uses its MCP settings or Codex
config.toml. Follow the web guide for ChatGPT web; local configuration and bridge TCP are
not web MCP URLs. Check actual transport availability and required approvals.

For new configurations set GMA3_DOCS_URL=hosted; preserve existing explicit local deployments.
The local alternative is http://127.0.0.1:8765 with a separately running index. Restart the
MCP server. Before console import, verify gma3_docs_search, gma3_docs_get and
gma3_docs_reference using returned IDs, source links and version provenance; test gma3_help.
Report unavailable docs explicitly; do not silently switch modes or deploy services.

Run node scripts/bridge-cli.mjs ping first. Reuse a working bridge. If absent, locate the
onPC library and copy every XML-referenced plugin component using the platform guide.
Have me identify a free Plugin slot and import/start the bridge using the documented
commands. Never overwrite an occupied slot. Reuse my open onPC session; leave Lua, input
and OSC disabled. Use the SSH guide for separate computers.

Verify gma3_status through my actual client: expected show, version, data pool and fresh
server build. Report passed checks and remaining steps. Avoid live tests and show changes.
```
