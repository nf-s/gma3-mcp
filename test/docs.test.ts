import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocsClient, docsClientFromEnvironment, docsOrigin, lookupIndexedHelp } from "../src/docs.ts";
import { registerDocsTools } from "../src/tools/docs.ts";
import { startHarness, textOf } from "./helpers/tool-harness.ts";

const source = { version: "2.5", authority: "manual", source_url: "https://help.malighting.com/grandMA3/2.5/HTML/keyword_goplus.html" };
const result = { id: "manual/keyword_goplus", title: "Go+ Keyword", kind: "manual", category: "command", ...source, excerpt: "Go+", exact_match: true };
const document = { ...result, text: 'Go+  Executor 1.201\n  /NoConfirmation\n', source_sha256: "a".repeat(64), publication_version: "2.5", page_version: "2.2" };
const record = {
  id: "manual/keyword_goplus/example/abc", document_id: result.id, text: document.text,
  type: "example", language: "ma3", ...source, raw_text: document.text,
  status: "documented-not-executed", source_document_id: result.id, source_document_title: result.title,
  source_document_url: "/?doc=manual%2Fkeyword_goplus", matched_keywords: [{ keyword_document_id: result.id, command: "Go+", category: "command", matched_tokens: ["Go+"], relation: "own-document" }],
};
const command = { ...record, source_records: [record], source_record_count: 1 };

async function service(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void, run: (origin: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function send(response: http.ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("docs configuration is opt-in and restricted to loopback HTTP origins", () => {
  assert.equal(docsClientFromEnvironment(undefined), undefined);
  for (const value of ["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765/"]) assert.ok(docsOrigin(value));
  for (const value of ["", "https://example.com", "http://192.168.1.2", "http://127.0.0.1/api", "http://a:b@localhost", "http://localhost/?password=secret", "http://localhost/#x", "file:///tmp/docs"]) {
    assert.throws(() => docsOrigin(value));
  }
});

test("search preserves punctuation and provenance and exposes stable pagination", async () => {
  await service((request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    assert.equal(request.method, "GET");
    assert.equal(url.pathname, "/api/search");
    assert.equal(url.searchParams.get("q"), 'Go+  $ /NoConfirmation');
    assert.equal(url.searchParams.get("kind"), "release_note");
    assert.equal(url.searchParams.get("edition"), "2.5.1.1");
    send(response, { results: [{ ...result, matched_edition: "2.5.1.1" }], total: 3, offset: 1, limit: 1, query: url.searchParams.get("q") });
  }, async (origin) => {
    const page = await new DocsClient(origin).search({ query: 'Go+  $ /NoConfirmation', kind: "release_note", edition: "2.5.1.1", offset: 1, limit: 1 });
    assert.equal(page.next_offset, 2);
    assert.equal(page.results[0]?.source_url, source.source_url);
    assert.equal(page.results[0]?.matched_edition, "2.5.1.1");
    assert.match(page.results[0]?.document_url ?? "", /doc=manual%2Fkeyword_goplus/);
  });
});

test("blank search accepts brief results without an exact-match indicator and never infers a match", async () => {
  const brief = {
    id: "manual/keyword_hashsquarebrackets", title: "#[Object] Keyword", kind: "manual", category: "command",
    ...source, source_url: "https://help.malighting.com/grandMA3/2.5/HTML/keyword_hashsquarebrackets.html",
    breadcrumbs: ["grandMA3 User Manual", "Command Syntax and Keywords", "General Keywords"],
    source_page: null, parent_id: "manual/csk_general_keywords", section: null, status: null,
    excerpt: "To enter the #[Object] character in the command line, type #[Object].", occurrence_count: 0,
  };
  await service((request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    assert.equal(url.searchParams.get("q"), "");
    send(response, { results: [brief], total: 1547, offset: 0, limit: 20, query: "" });
  }, async (origin) => {
    const page = await new DocsClient(origin).search({});
    assert.equal(page.total, 1547);
    assert.equal(page.results[0]?.exact_match, false);
    assert.equal(page.results[0]?.id, brief.id);
    assert.equal(page.results[0]?.source_url, brief.source_url);
  });
});

test("edition search validates brief occurrence provenance without requiring a full document hash", async () => {
  const matched = {
    version: "2.5", publication_version: "2.5.1.1", document_id: "release/2026-10-07-release-notes-v2-5-1-1",
    source_url: "/release-notes-pdf/2026_10_07_Release_Notes_v2.5.1.1.pdf#page=25",
    source_page: 25, section: "Command Line and Macro",
  };
  const brief = {
    id: "release-entry/25f73cde41c411464972", title: "Command Line and Macro: Store selective preset values",
    kind: "release_note", category: "bug-fixes", version: "2.5", authority: "release-note",
    source_url: matched.source_url, source_page: 25, section: null,
    status: "release_note_supplement_requires_current_manual_check", excerpt: "If you extracted a selective preset and stored it as global, the values would still be stored as selective.",
    occurrence_count: 2, matched_edition: "2.5.1.1", matched_occurrences: [matched], exact_match: false,
  };
  await service((request, response) => send(response, { results: [brief], total: 28, offset: 0, limit: 20, query: "Store" }), async (origin) => {
    const page = await new DocsClient(origin).search({ query: "Store", kind: "all", edition: "2.5.1.1" });
    assert.equal(page.total, 28);
    assert.equal(page.results[0]?.version, "2.5");
    assert.equal(page.results[0]?.matched_edition, "2.5.1.1");
    assert.deepEqual(page.results[0]?.matched_occurrences, [matched]);
  });
  for (const invalid of [{ ...matched, document_id: undefined }, { ...matched, source_url: undefined }]) {
    await service((request, response) => send(response, { results: [{ ...brief, matched_occurrences: [invalid] }], total: 1, offset: 0, limit: 20, query: "Store" }), async (origin) => {
      await assert.rejects(new DocsClient(origin).search({ query: "Store", kind: "all", edition: "2.5.1.1" }), /missing source provenance/);
    });
  }
  await service((request, response) => send(response, { ...document, occurrences: [matched] }), async (origin) => {
    await assert.rejects(new DocsClient(origin).get({ id: result.id }), /missing source provenance/);
  });
});

test("get paginates original text without altering whitespace or version labels", async () => {
  await service((request, response) => send(response, { ...document, html: "<script>execute()</script>" }), async (origin) => {
    const client = new DocsClient(origin);
    const first = await client.get({ id: result.id, max_chars: 10 });
    assert.equal(first.text, document.text.slice(0, 10));
    assert.equal(first.text_page.next_offset, 10);
    const rest = await client.get({ id: result.id, offset: 10 });
    assert.equal(first.text + rest.text, document.text);
    assert.equal(rest.text_page.next_offset, null);
    assert.equal(rest.publication_version, "2.5");
    assert.equal(rest.page_version, "2.2");
    assert.equal("html" in rest, false);
  });
});

test("reference uses the exact scoped identity and retains complete raw extracts and source records", async () => {
  await service((request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    assert.equal(url.pathname, "/api/commands");
    assert.equal(url.searchParams.get("keyword_document_id"), "manual/lua_object_addr");
    assert.equal(url.searchParams.get("reference_kind"), "lua");
    assert.equal(url.searchParams.get("authority"), "all");
    send(response, { results: [command], total: 1, record_total: 1, offset: 0, limit: 20, keyword_document_id: "manual/lua_object_addr", keyword_matches: [{ document_id: "manual/lua_object_addr", command: "Addr", category: "lua", scope: "object" }] });
  }, async (origin) => {
    const page = await new DocsClient(origin).reference({ reference_id: "manual/lua_object_addr", reference_kind: "lua", authority: "all" });
    assert.equal(page.results[0]?.text, document.text);
    assert.equal(page.results[0]?.raw_text, document.text);
    assert.deepEqual(page.results[0]?.source_records, [{ ...record, source_link: source.source_url, source_document_link: `${origin}/?doc=manual%2Fkeyword_goplus` }]);
    assert.equal(page.next_offset, null);
  });
});

test("malformed, provenance-free or mismatched documents and extracts are rejected", async () => {
  for (const payload of [{ ...document, source_url: undefined }, { ...document, source_url: "javascript:execute()" }, { ...document, id: "manual/other" }, { ...document, live_lua_signature: { name: "Addr" } }]) {
    await service((request, response) => send(response, payload), async (origin) => {
      await assert.rejects(new DocsClient(origin).get({ id: result.id }), /invalid data|different document identity/);
    });
  }
  await service((request, response) => send(response, { results: [{ ...command, source_records: [{ ...record, version: undefined }] }], total: 1, record_total: 1, offset: 0, limit: 20, keyword_document_id: result.id, keyword_matches: [] }), async (origin) => {
    await assert.rejects(new DocsClient(origin).reference({ reference_id: result.id }), /missing source provenance/);
  });
});

test("redirects, non-JSON, invalid JSON, oversized bodies, timeouts and inconsistent pages fail explicitly", async () => {
  let redirected = false;
  await service((request, response) => {
    if (request.url === "/target") redirected = true;
    response.writeHead(302, { location: "/target" });
    response.end();
  }, async (origin) => {
    await assert.rejects(new DocsClient(origin).get({ id: result.id }), /HTTP 302/);
    assert.equal(redirected, false);
  });
  await service((request, response) => response.end("<html>Login</html>"), async (origin) => {
    await assert.rejects(new DocsClient(origin).get({ id: result.id }), /did not return JSON/);
  });
  await service((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("{"); }, async (origin) => {
    await assert.rejects(new DocsClient(origin).get({ id: result.id }), SyntaxError);
  });
  await service((request, response) => send(response, document), async (origin) => {
    await assert.rejects(new DocsClient(origin, { maxResponseBytes: 20 }).get({ id: result.id }), /size limit/);
  });
  await service(() => {}, async (origin) => {
    await assert.rejects(new DocsClient(origin, { timeoutMs: 20 }).get({ id: result.id }), /timed out/);
  });
  await service((request, response) => send(response, { results: [], total: 1, offset: 0, limit: 20, query: "Store" }), async (origin) => {
    await assert.rejects(new DocsClient(origin).search({ query: "Store" }), /inconsistent pagination/);
  });
});

test("oversized extract pages shrink on complete record boundaries and continue without gaps", async () => {
  const large = { ...command, text: " ".repeat(17000), source_records: [{ ...record, text: " ".repeat(17000) }] };
  await service((request, response) => send(response, { results: [large, large], total: 3, record_total: 3, offset: 0, limit: 2, keyword_document_id: result.id, keyword_matches: [] }), async (origin) => {
    const page = await new DocsClient(origin).reference({ reference_id: result.id, limit: 2 });
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]?.text.length, 17000);
    assert.equal(page.next_offset, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64000);
  });
});

test("indexed help prioritises a unique command over a physical key, preserving file-name compatibility", async () => {
  await service((request, response) => {
    if (request.url?.startsWith("/api/document")) send(response, document);
    else send(response, { results: [result, { ...result, id: "manual/key_go", category: "key" }], total: 2, offset: 0, limit: 20, query: "Go+" });
  }, async (origin) => {
    const client = new DocsClient(origin);
    assert.equal((await lookupIndexedHelp("Go+", 12000, client)).text, document.text);
    assert.equal((await lookupIndexedHelp("keyword_goplus.html", 12000, client)).text, document.text);
  });
});

test("three docs tools validate inputs, return read errors, and need no bridge", async () => {
  let requests = 0;
  await service((request, response) => { requests++; response.writeHead(503); response.end(); }, async (origin) => {
    const client = new DocsClient(origin);
    const harness = await startHarness((server) => registerDocsTools(server, client));
    try {
      assert.deepEqual([...harness.tools.keys()], ["gma3_docs_search", "gma3_docs_get", "gma3_docs_reference"]);
      const invalid = await harness.call("gma3_docs_reference", { reference_id: "manual/x", limit: 201 });
      assert.equal(invalid.isError, true);
      assert.equal(requests, 0);
      const failed = await harness.call("gma3_docs_search", { query: "Go+" });
      assert.equal(failed.isError, true);
      assert.match(textOf(failed), /HTTP 503/);
      assert.equal(harness.fake.requests.length, 0);
    } finally {
      await harness.close();
    }
  });
});
