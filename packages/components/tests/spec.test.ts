import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComponentError, MAX_COMPONENT_BYTES, componentBytes, createComponentMarkdown, parseComponentSpec, safeLink, sortableDate, tableLink,
} from "../src/spec.js";

const chart = () => ({
  type: "line", title: "Tasks", xAxisKey: "day",
  data: [{ day: "Monday", completed: 4 }, { day: "Tuesday", completed: 6 }],
  series: [{ name: "Completed", dataKey: "completed", color: "#006b5d" }],
});

test("supported component descriptions retain their complete data", () => {
  assert.deepEqual(parseComponentSpec(chart()), chart());
  assert.equal(parseComponentSpec({ ...chart(), type: "bar" }).type, "bar");
  const table = { type: "datagrid", columns: [{ key: "name", label: "Name" }], rows: [{ name: "A" }] };
  assert.deepEqual(parseComponentSpec(table), table);
  const markdown = { type: "markdown", content: "## Heading\nText, not executable markup." };
  assert.deepEqual(parseComponentSpec(markdown), markdown);
});

test("unsupported types and unsupported configuration are explicit failures", () => {
  for (const type of ["dashboard", "explainer", "sequence", "pie", "hbar", "chart", "html", "script"])
    assert.throws(() => parseComponentSpec({ type }), { code: "COMPONENT_UNSUPPORTED" });
  assert.throws(() => parseComponentSpec({ ...chart(), formatter: "execute()" }), { code: "COMPONENT_INVALID" });
  assert.throws(() => parseComponentSpec({ ...chart(), series: [{ name: "A", dataKey: "missing" }] }),
    { code: "COMPONENT_INVALID" });
  assert.throws(() => parseComponentSpec(null), ComponentError);
});

test("table bounds accept their exact boundary and reject excess without truncation", () => {
  const columns = Array.from({ length: 20 }, (_, index) => ({ key: `c${index}`, label: `Column ${index}` }));
  const rows = Array.from({ length: 1000 }, (_, index) => ({ c0: index }));
  const accepted = parseComponentSpec({ type: "datagrid", columns, rows });
  assert.equal(accepted.type, "datagrid");
  if (accepted.type !== "datagrid") throw new Error("Wrong component.");
  assert.equal(accepted.rows.length, 1000);
  assert.equal(accepted.columns.length, 20);
  assert.throws(() => parseComponentSpec({ type: "datagrid", columns, rows: [...rows, {}] }),
    { code: "COMPONENT_TOO_LARGE" });
  assert.throws(() => parseComponentSpec({ type: "datagrid", columns: [...columns, { key: "extra", label: "Extra" }], rows }),
    { code: "COMPONENT_TOO_LARGE" });
});

test("the chart value budget covers all series, including explicit gaps", () => {
  const series = [{ name: "One", dataKey: "one" }, { name: "Two", dataKey: "two" }];
  const data = Array.from({ length: 500 }, (_, day) => ({ day, one: day, two: day % 2 ? null : day }));
  const accepted = parseComponentSpec({ type: "line", xAxisKey: "day", series, data });
  assert.equal(accepted.type, "line");
  if (accepted.type !== "line") throw new Error("Wrong component.");
  assert.equal(accepted.data.length * accepted.series.length, 1000);
  assert.throws(() => parseComponentSpec({ type: "line", xAxisKey: "day", series, data: [...data, data[0]] }),
    { code: "COMPONENT_TOO_LARGE" });
});

test("the byte limit measures serialized UTF-8 rather than characters", () => {
  const empty = parseComponentSpec({ type: "markdown", content: "" });
  const overhead = componentBytes(empty);
  const full = { type: "markdown", content: "a".repeat(MAX_COMPONENT_BYTES - overhead) };
  assert.equal(componentBytes(parseComponentSpec(full)), MAX_COMPONENT_BYTES);
  assert.throws(() => parseComponentSpec({ ...full, content: full.content + "a" }), { code: "COMPONENT_TOO_LARGE" });
  assert.throws(() => parseComponentSpec({ type: "markdown", content: "界".repeat(90_000) }),
    { code: "COMPONENT_TOO_LARGE" });
});

test("data contracts reject prototype fields, ambiguous series and invalid numeric cells", () => {
  const invalid = [
    { ...chart(), series: [{ name: "A", dataKey: "day" }] },
    { ...chart(), series: [...chart().series, ...chart().series] },
    { ...chart(), data: [{ day: "Monday", completed: Number.POSITIVE_INFINITY }] },
    { ...chart(), data: [{ day: "Monday", completed: "4" }] },
    { ...chart(), data: [{ day: "Monday", completed: 4, secret: "not a displayed field" }] },
    { ...chart(), data: [JSON.parse('{"day":"Monday","completed":4,"__proto__":"unsafe"}')] },
    { type: "datagrid", columns: [{ key: "n", label: "N", type: "number" }], rows: [{ n: "1" }] },
    { type: "datagrid", columns: [{ key: "n", label: "N" }, { key: "n", label: "Duplicate" }], rows: [] },
  ];
  for (const value of invalid) assert.throws(() => parseComponentSpec(value), { code: "COMPONENT_INVALID" });
});

test("link handling permits explicit web destinations but no credentials or script schemes", () => {
  assert.equal(safeLink("https://example.com/items/42"), "https://example.com/items/42");
  for (const value of ["javascript:alert(1)", "file:///private", "data:text/html,x", "//example.com",
    "https://name:secret@example.com", "https://example.com/\n", "https:\\\\example.com", " intent://x"])
    assert.equal(safeLink(value), null);
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href: "https://example.com/items/{value}" },
    { id: "a/b" }), "https://example.com/items/a%2Fb");
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", hrefKey: "url" },
    { id: 42, url: "https://example.com/items/42" }), "https://example.com/items/42");
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href: "https://example.com/{missing}" }, { id: 42 }), null);
  assert.equal(tableLink({ key: "id", label: "ID", type: "link" }, { id: "javascript:alert(1)" }), null);
});

test("link expansion stops reading substitutions once the URL cannot fit its bound", () => {
  let reads = 0;
  const row = { id: "View", get detail() { reads++; return "x".repeat(8000); } };
  const href = "https://example.test/" + "{detail}".repeat(200);
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href }, row), null);
  assert.equal(reads, 2, "Do not expand every occurrence of an already oversized value.");
  const prefix = "https://example.test/", exact = "x".repeat(2000 - prefix.length);
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href: prefix + "{value}" }, { id: exact }), prefix + exact);
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href: prefix + "{value}" }, { id: exact + "x" }), null);
});

test("invalid Unicode disables a templated link rather than throwing during projection or rendering", () => {
  assert.equal(tableLink({ key: "id", label: "ID", type: "link", href: "https://example.test/{value}" },
    { id: "\ud800" }), null);
});

test("normalized URL length remains within the native host limit after Unicode expansion", () => {
  const prefix = "https://example.test/", expanded = prefix + "\u754c".repeat(300);
  assert.ok(expanded.length < 2000);
  assert.ok(new URL(expanded).href.length > 2000);
  assert.equal(safeLink(expanded), null);
  assert.equal(tableLink({ key: "url", label: "Link", type: "link" }, { url: expanded }), null);
  const stem = prefix + "\u754c".repeat(210), exact = stem + "x".repeat(2000 - new URL(stem).href.length);
  assert.equal(new URL(exact).href.length, 2000);
  assert.equal(safeLink(exact), new URL(exact).href);
  assert.equal(safeLink(exact + "x"), null);
});

test("rendering and privacy inspection share the same non-HTML Markdown grammar", () => {
  const parser = createComponentMarkdown(), environment: { references?: Record<string, { href: string }> } = {};
  assert.equal(parser.options.html, false);
  assert.equal(parser.options.linkify, false);
  assert.equal(parser.options.typographer, false);
  assert.equal(parser.options.breaks, true);
  const tokens = parser.parse("[Link][item]\n\n[item]: https://example.test/?id=1&amp;page=2", environment);
  const link = tokens.flatMap((token) => token.children ?? []).find((token) => token.type === "link_open");
  assert.equal(link?.attrGet("href"), "https://example.test/?id=1&page=2");
  assert.equal(environment.references?.ITEM?.href, "https://example.test/?id=1&page=2");
  assert.ok(parser.render("<script>not executable</script>").includes("&lt;script&gt;"));
});

test("date columns reject ambiguous dates and compare actual offset-qualified instants", () => {
  assert.equal(sortableDate("2026-10-19T08:00:00+08:00"), sortableDate("2026-10-19T00:00:00Z"));
  assert.equal(sortableDate("10/19/2026"), null);
  assert.equal(sortableDate(true), null);
  assert.equal(sortableDate(8.64e15 + 1), null);
  assert.throws(() => parseComponentSpec({
    type: "datagrid", columns: [{ key: "at", label: "At", type: "date" }], rows: [{ at: "tomorrow" }],
  }), { code: "COMPONENT_INVALID" });
});

test("date columns reject calendar overflow rather than silently moving it to another month", () => {
  for (const value of ["2026-02-31", "2026-02-29", "2026-04-31T08:00:00+08:00"]) {
    assert.equal(sortableDate(value), null);
    assert.throws(() => parseComponentSpec({
      type: "datagrid", columns: [{ key: "at", label: "At", type: "date" }], rows: [{ at: value }],
    }), { code: "COMPONENT_INVALID" });
  }
  assert.equal(sortableDate("2024-02-29"), Date.parse("2024-02-29T00:00:00Z"));
});
