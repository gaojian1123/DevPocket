import {
  BarController, BarElement, CategoryScale, Chart, LinearScale, LineController, LineElement,
  PointElement, Tooltip, type ChartConfiguration,
} from "chart.js";
import {
  ComponentError, createComponentMarkdown, parseComponentSpec, safeLink, sortableDate, tableLink,
  type CellValue, type ChartSpec, type ComponentSpec, type TableSpec,
} from "./spec.js";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip);

export type RenderOptions = {
  view: "inline" | "detail";
  theme: "light" | "dark";
  onOpenLink(url: string): void;
  onSizeChanged?(height: number): void;
};
export type RenderedComponent = { dispose(): void };

const colors = ["#006b5d", "#2563eb", "#c17a16", "#8856a7", "#c54c4c", "#407c90"];
const text = (value: CellValue | undefined): string => value === null || value === undefined ? "\u2014" : String(value);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

function button(label: string, action: () => void): HTMLButtonElement {
  const node = element("button", "control", label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function provenance(parent: HTMLElement, spec: ComponentSpec): void {
  if (spec.type === "markdown") return;
  if (spec.source) parent.append(element("p", "source", spec.source));
  if (spec.query) {
    const details = element("details", "source-query");
    details.append(element("summary", undefined, "查看数据来源查询"), element("pre", undefined, spec.query));
    parent.append(details);
  }
}

function renderTable(parent: HTMLElement, spec: TableSpec, options: RenderOptions): void {
  const controls = element("div", "table-controls");
  const search = element("input", "filter");
  search.type = "search";
  search.placeholder = "筛选表格";
  search.setAttribute("aria-label", "筛选表格所有列");
  const count = element("span", "row-count");
  controls.append(search, count);
  const viewport = element("div", "table-scroll");
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "数据表格，可横向滚动");
  const table = element("table"), head = element("thead"), body = element("tbody");
  const header = element("tr");
  const headings: HTMLTableCellElement[] = [];
  let page = 0, sortKey: string | undefined, descending = false;
  const pageSize = options.view === "inline" ? Math.min(spec.pageSize ?? 5, 5) : spec.pageSize ?? 25;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const pager = element("div", "pager"), pageLabel = element("span", "page-label");
  const previous = button("上一页", () => { page--; draw(); });
  const next = button("下一页", () => { page++; draw(); });

  function draw(): void {
    const query = search.value.toLocaleLowerCase();
    const rows = spec.rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => spec.columns.some((column) => text(row[column.key]).toLocaleLowerCase().includes(query)));
    if (sortKey) {
      const column = spec.columns.find((item) => item.key === sortKey)!;
      rows.sort((left, right) => {
        const a = left.row[column.key], b = right.row[column.key];
        if (a === null || a === undefined) return b === null || b === undefined ? left.index - right.index : 1;
        if (b === null || b === undefined) return -1;
        const dateA = column.type === "date" ? sortableDate(a) : null;
        const dateB = column.type === "date" ? sortableDate(b) : null;
        const order = dateA !== null && dateB !== null ? dateA - dateB :
          typeof a === "number" && typeof b === "number" ? a - b : collator.compare(text(a), text(b));
        return (descending ? -order : order) || left.index - right.index;
      });
    }
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    count.textContent = `${rows.length} / ${spec.rows.length} 行`;
    pageLabel.textContent = `${page + 1} / ${pages} 页`;
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    body.replaceChildren();
    for (const { row } of rows.slice(page * pageSize, (page + 1) * pageSize)) {
      const tr = element("tr");
      for (const column of spec.columns) {
        const cell = element("td");
        cell.style.textAlign = column.align ?? (column.type === "number" ? "right" : "left");
        const value = text(row[column.key]);
        if (column.type === "link") {
          const url = tableLink(column, row);
          if (url) {
            const link = button(value, () => options.onOpenLink(url));
            link.className = "data-link";
            link.setAttribute("aria-label", `${value}，在外部浏览器打开`);
            cell.append(link);
          } else {
            cell.textContent = value;
            cell.append(element("span", "invalid-link", "（链接不可用）"));
          }
        } else cell.textContent = value;
        tr.append(cell);
      }
      body.append(tr);
    }
    if (!rows.length) {
      const tr = element("tr"), cell = element("td", "empty", "没有匹配的数据");
      cell.colSpan = spec.columns.length;
      tr.append(cell); body.append(tr);
    }
    headings.forEach((heading, index) => {
      const selected = spec.columns[index]!.key === sortKey;
      heading.setAttribute("aria-sort", selected ? (descending ? "descending" : "ascending") : "none");
    });
  }

  for (const column of spec.columns) {
    const heading = element("th");
    heading.scope = "col";
    heading.style.textAlign = column.align ?? (column.type === "number" ? "right" : "left");
    heading.append(button(column.label, () => {
      descending = sortKey === column.key ? !descending : false;
      sortKey = column.key; page = 0; draw();
    }));
    headings.push(heading);
    header.append(heading);
  }
  search.addEventListener("input", () => { page = 0; draw(); });
  head.append(header); table.append(head, body); viewport.append(table);
  pager.append(previous, pageLabel, next);
  parent.append(controls, viewport, pager);
  draw();
}

function renderChart(parent: HTMLElement, spec: ChartSpec, options: RenderOptions): () => void {
  if (!spec.data.length) {
    parent.append(element("p", "empty", "图表没有数据"));
    return () => {};
  }
  const chartBox = element("div", "chart-box");
  const canvas = element("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${spec.title ?? "图表"}，${spec.series.length} 个系列；完整数值可在下方数据表查看`);
  chartBox.append(canvas);
  const legend = element("ul", "legend");
  spec.series.forEach((series, index) => {
    const item = element("li"), swatch = element("span", "swatch");
    swatch.style.backgroundColor = series.color ?? colors[index % colors.length]!;
    item.append(swatch, document.createTextNode(series.name));
    legend.append(item);
  });
  const details = element("details", "chart-data");
  details.append(element("summary", undefined, "查看图表完整数据"));
  const values = spec.data.flatMap((row) => spec.series.map((series) => ({
    category: row[spec.xAxisKey]!, series: series.name, value: row[series.dataKey]!,
  })));
  let dataRendered = false;
  details.addEventListener("toggle", () => {
    if (details.open && !dataRendered) {
      dataRendered = true;
      renderTable(details, { type: "datagrid", columns: [
        { key: "category", label: "类别" }, { key: "series", label: "系列" },
        { key: "value", label: spec.yAxisLabel ?? "数值", type: "number" },
      ], rows: values }, { ...options, view: "detail" });
    }
  });
  parent.append(chartBox, legend, details);
  const foreground = options.theme === "dark" ? "#d6e4dc" : "#34483e";
  const grid = options.theme === "dark" ? "#354b41" : "#e1e9e3";
  const common: ChartConfiguration<"line" | "bar", (number | null)[], string> = {
    type: spec.type,
    data: {
      labels: spec.data.map((row) => text(row[spec.xAxisKey])),
      datasets: spec.series.map((series, index) => ({
        label: series.name,
        data: spec.data.map((row) => {
          const value = row[series.dataKey];
          if (value === null || typeof value === "number") return value;
          throw new ComponentError("COMPONENT_INVALID", "The chart series contains an invalid value.");
        }),
        borderColor: series.color ?? colors[index % colors.length],
        backgroundColor: series.color ?? colors[index % colors.length],
        borderWidth: spec.type === "line" ? 2 : 0,
        pointRadius: spec.data.length > 80 ? 0 : 3,
        pointHitRadius: 12,
        tension: 0,
        spanGaps: false,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      events: ["mousemove", "mouseout", "click", "touchstart"],
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { enabled: true } },
      scales: {
        x: { ticks: { color: foreground, maxTicksLimit: options.view === "inline" ? 5 : 8 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: foreground }, grid: { color: grid },
          title: { display: Boolean(spec.yAxisLabel), text: spec.yAxisLabel, color: foreground } },
      },
    },
  };
  const chart = new Chart(canvas, common);
  return () => chart.destroy();
}

function renderMarkdown(parent: HTMLElement, content: string, options: RenderOptions): void {
  const parser = createComponentMarkdown();
  parser.renderer.rules.image = () => '<span class="unsupported-image" role="note">此客户端暂不显示图片。</span>';
  const renderLink: NonNullable<typeof parser.renderer.rules.link_open> = parser.renderer.rules.link_open ??
    ((tokens, index, settings, _environment, renderer) => renderer.renderToken(tokens, index, settings));
  parser.renderer.rules.link_open = (tokens, index, settings, environment, renderer) => {
    const token = tokens[index]!;
    const url = safeLink(token.attrGet("href") ?? "");
    token.attrSet("href", "#");
    if (url) token.attrSet("data-url", url);
    else {
      token.attrSet("aria-disabled", "true");
      token.attrSet("title", "链接格式不受支持");
    }
    token.attrSet("rel", "noopener noreferrer");
    return renderLink(tokens, index, settings, environment, renderer);
  };
  const body = element("div", "markdown");
  body.innerHTML = parser.render(content);
  body.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link) return;
    event.preventDefault();
    const url = safeLink(link.dataset.url ?? "");
    if (url) options.onOpenLink(url);
  });
  parent.append(body);
}

export function renderComponent(root: HTMLElement, input: unknown, options: RenderOptions): RenderedComponent {
  const spec = parseComponentSpec(input);
  root.replaceChildren();
  root.dataset.theme = options.theme;
  root.dataset.view = options.view;
  root.className = "component";
  let release = () => {};
  if (spec.type === "line" || spec.type === "bar") release = renderChart(root, spec, options);
  else if (spec.type === "datagrid") renderTable(root, spec, options);
  else renderMarkdown(root, spec.content, options);
  provenance(root, spec);
  let height = -1;
  const measure = () => {
    const next = Math.ceil(root.scrollHeight);
    if (next !== height) { height = next; options.onSizeChanged?.(next); }
  };
  const observer = new ResizeObserver(measure);
  observer.observe(root);
  measure();
  return { dispose: () => { observer.disconnect(); release(); root.replaceChildren(); } };
}
