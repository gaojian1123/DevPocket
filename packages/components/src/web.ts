import { z } from "zod";
import { ComponentError, COMPONENT_VERSION, MAX_COMPONENT_BYTES } from "./spec.js";
import { renderComponent, type RenderedComponent } from "./renderer.js";

declare global {
  interface Window {
    devPocketHost?: { postMessage(message: string): void };
  }
}

const request = z.object({
  version: z.literal(COMPONENT_VERSION),
  type: z.literal("render"),
  requestId: z.string().min(1).max(200),
  view: z.enum(["inline", "detail"]),
  theme: z.enum(["light", "dark"]),
  spec: z.unknown(),
}).strict();

const root = document.getElementById("component");
if (!root) throw new Error("The component root is missing.");
let rendered: RenderedComponent | undefined;
function showError(message: string): void {
  rendered?.dispose();
  rendered = undefined;
  if (root) root.textContent = message;
}
const send = (message: object) => {
  if (!window.devPocketHost) throw new Error("The native component host is unavailable.");
  window.devPocketHost.postMessage(JSON.stringify({ version: COMPONENT_VERSION, ...message }));
};

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > MAX_COMPONENT_BYTES + 4096) {
    showError("组件消息无效或超过大小限制。");
    return;
  }
  let value: unknown;
  try { value = JSON.parse(event.data); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    showError("组件消息无法解析。");
    return;
  }
  const input = request.safeParse(value);
  if (!input.success) { showError("组件消息协议不受支持。"); return; }
  rendered?.dispose();
  rendered = undefined;
  const { requestId, spec, view, theme } = input.data;
  try {
    rendered = renderComponent(root, spec, {
      view, theme,
      onOpenLink: (url) => send({ type: "open-link", requestId, url }),
      onSizeChanged: (height) => send({ type: "height", requestId, height }),
    });
    send({ type: "rendered", requestId });
  } catch (error) {
    if (!(error instanceof ComponentError)) {
      root.textContent = "组件显示失败。请返回对话，或在原始客户端查看。";
      send({ type: "error", requestId, code: "COMPONENT_RENDER_FAILED" });
      throw error;
    }
    root.textContent = error.code === "COMPONENT_TOO_LARGE" ? "组件超过显示上限，请在原始客户端查看。" :
      error.code === "COMPONENT_UNSUPPORTED" ? "此客户端暂不支持这种组件。" : "组件数据或配置不受支持。";
    send({ type: "error", requestId, code: error.code });
  }
});

send({ type: "ready" });
