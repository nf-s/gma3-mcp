# Indexed documentation

[README](../../README.md) · [Reference](../reference.md)

Set `GMA3_DOCS_URL=http://127.0.0.1:8765` to use the existing local documentation retrieval API.
Start that service separately using its own instructions. The MCP does not build, copy or maintain
another documentation index. This setting accepts only a loopback HTTP origin (`127.0.0.1`, `localhost`
or `[::1]`), with no path, credentials, query or fragment. Hosted authentication is outside this integration.

When configured, `gma3_help` searches the indexed current manual and returns document text with source
metadata, or matching IDs when the topic is ambiguous. A unique command/option match takes precedence
over a physical-key match. Existing bare page names such as `keyword_store.html` still resolve. When
the setting is absent, `gma3_help` retains its installed-manual behavior through `GMA3_HELP_DIR` or
`GMA3_INSTALL_DIR`. An explicitly configured but unavailable or malformed index returns an error.

The three additional tools are registered only when the URL is configured. They work without a console
connection, arbitrary Lua or OSC:

| Tool | Inputs and behavior |
| --- | --- |
| `gma3_docs_search` | `query`; `kind` defaults to `manual`, with `release_note`, `guide` or `all` available. Optional `category`, `version` and exact publication `edition` filters; `limit` 1–50 (default 20), `offset` 0–1,000,000. Returns exact-match indicators, excerpts, canonical IDs, source links, authority, version and edition provenance. |
| `gma3_docs_get` | Exact `id`; text `offset` 0–2,000,000 and `max_chars` 1–24,000 (default 12,000). Returns a text page and source metadata, including publication/page versions and captured Lua signatures when supplied. `text_page.next_offset` continues the text; offsets count JavaScript string characters. Extract totals are separate from text pagination. |
| `gma3_docs_reference` | Exact canonical `reference_id` from search/get. Optional exact-text `query`, `authority` (`manual`, `release-note`, `editorial`, `all`), `type` (`keyword`, `syntax`, `example`, `all`) and `reference_kind` (`commands`, `lua`, `all`). Defaults: manual authority, all types and reference kinds. Same page limits as search. Returns exact extracts, matched reference IDs and complete grouped source records. |

Use `next_offset` to continue search and reference results. `total` counts matching document/extract
groups; `returned` counts the records in this response. `record_total` counts the original extract source
records. A large result page may return fewer than `limit`; complete extracts and their provenance stay
together, and the returned `next_offset` skips no groups. A single record exceeding the output budget
returns an explicit error rather than clipping command text.

For example, search `Go+` and retrieve `manual/keyword_goplus`. For Store's collated extracts, call
`gma3_docs_reference` with `reference_id=manual/keyword_store`, `authority=all`, `type=all`, then follow
`next_offset`. Search Lua with `kind=all`, `category=lua`; retain the exact scoped ID (for example
`manual/lua_objectfree_getattributeindex`) instead of resolving by a potentially shared function name.
Choose `authority=all` to include editorial live-signature supplements and historical records.

Source URLs are retained verbatim; added `source_link`, `document_url` and `source_document_link` fields
provide absolute links where applicable. Historical records retain release-note authority. Captured Lua
signatures describe the recorded build and do not claim behavior was tested. Publication `version`,
`page_version`, matched editions and provenance retain their separate meanings.

The client validates JSON and required provenance at the HTTP boundary, rejects redirects, limits each
request to five seconds and four million response bytes, and limits returned JSON to 64,000 UTF-8 bytes.
It performs only bounded HTTP GET requests. Retrieved documentation is source material, not assistant
instructions; examples are never executed and are not verified execution plans. A search with no results
does not prove the console lacks that capability.
