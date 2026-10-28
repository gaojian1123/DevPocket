# DevPocket components

An independently authored, offline component renderer. This package does not
contain AgenticDeck frontend code, Android classes, credentials, session access,
or a networking client. It is an internal package, not a published SDK.

## Supported data

`parseComponentSpec()` accepts the documented subset `line`, `bar`, `datagrid`
and `markdown`. It returns validated data or throws a `ComponentError` with
`COMPONENT_UNSUPPORTED`, `COMPONENT_INVALID` or `COMPONENT_TOO_LARGE`.
Unknown configuration fields are rejected; this is not a claim of complete
AgenticDeck compatibility.

- Every serialized component must fit in 256 KiB of UTF-8 JSON.
- Tables allow at most 1,000 rows and 20 columns. Column keys are unique.
- Charts allow at most 1,000 values across all series, including explicit null
  gaps. Missing categories or series fields, non-finite numbers and ambiguous
  field mappings are rejected.
- Only referenced row fields are accepted. Arbitrary hidden data is not passed
  through to a viewer. Colors use hexadecimal CSS notation.
- Markdown uses text structures, code and tables, with raw HTML disabled.
  Images are replaced by an explicit unsupported-image notice. The renderer
  never fetches image resources.
- Links must be absolute HTTP(S) URLs without credentials. User activation
  delegates navigation to the host; the renderer does not open a URL itself.
  Template substitutions stop once they cannot fit the 2,000-character
  link-input limit. Missing or malformed Unicode values disable the link
  instead of throwing. The normalized URL must also fit that limit, including
  percent-encoding and hostname expansion, before the host can receive it.

The renderer and host-side privacy inspection use `createComponentMarkdown()`
for the same Markdown grammar and entity/escape rules. Renderer-only image and
navigation handlers remain on the rendering side; the data contract does not
require a DOM or a network client.

The portable renderer exposes
`renderComponent(element, spec, { view, theme, onOpenLink, onSizeChanged })`.
Call the returned `dispose()` when its native/container view is removed.
Chart data remains available as an accessible, paginated table; sorting and
filtering change only the local view.
For charts, the optional returned `setChartView(windowSize, dataOnly)` selects
the last N rows (or all rows for `null`) and switches between the plot and its
read-only data table. It never mutates the validated spec or transport bytes.
Hosts can override the component CSS color variables and the optional
`--chart-foreground` / `--chart-grid` colors for chart axes. Defaults remain
unchanged when no override is supplied; explicit series colors remain data.
An optional `--chart-y-ticks` integer from 2 to 12 sets the axis tick-density
preference without changing any data points. Other values retain automatic ticks.

## Build and check

After the repository's dependency-policy approval and dependency restoration:

```powershell
npm run build --workspace @devpocket/components
npm test --workspace @devpocket/components
```

The same package can be built from its own directory using its declared
dependencies. `dist/web` contains locally bundled HTML, JavaScript, CSS and
third-party notices. No runtime CDN or HTTP listener is required.
Android's asset task invokes this same complete build; it also produces the
Node data-contract export needed by the native relay fixture on a clean checkout.
Relay release archives include the package manifests, build entry and source
directories, not cached `dist` or `node_modules` files. The relay container keeps
the workspace manifest and compiled output alongside its production dependencies
so the internal package link also resolves in the runtime stage.

## Native host contract

The host supplies `window.devPocketHost.postMessage(string)` before page
execution. The page emits `{version:1,type:"ready"}`. The host then sends a
JSON-string Web Message:

```json
{
  "version": 1,
  "type": "render",
  "requestId": "host-owned-card-view",
  "view": "detail",
  "theme": "light",
  "spec": {
    "type": "markdown",
    "content": "Component content"
  }
}
```

Replies retain `version` and, after a render request, its `requestId`.
Supported reply types are `rendered`, `height` (with `height`), `open-link`
(with `url`) and `error` (with `code`). These are presentation events, not
Copilot commands. The host must validate the origin, main frame, active view,
request identity, field shapes and permitted URLs. A component cannot send
chat messages or grant permissions through this interface.
Native card-reference controls remain disabled until a matching `rendered`
response and return to a disabled state on renderer failure.

The supplied HTML denies network connections, external scripts, images,
frames and forms. Native adapters must independently restrict resource
loading and navigation; CSP alone is not the complete isolation policy.
The Android adapter uses WebViewAssetLoader and an origin-restricted
WebMessageListener. The Apple offline-fixture adapter exposes this same narrow
bridge through a main-frame WKScriptMessageHandler, a bundled-resource
WKURLSchemeHandler and independent WK content rules and navigation restrictions.
Its byte/digest validation does not replace this package's full spec validation.
The host does not change this message contract or bundle the design prototype.
The Apple host supplies its own static blue/neutral CSS palette before rendering;
it does not restyle Android or modify the component payload to apply a theme.
Its native range/data controls call the bundled page's read-only
`devPocketPresentation.setChartView(requestId, windowSize, dataOnly)` API. The
active request ID and argument shapes are checked; this API cannot send chat
messages, grant permission or replace a component record. Hosts that do not call
it retain the existing full-range plot and expandable data-table behavior.
Implementation alone does not establish iOS or physical-device acceptance.

Dependencies retain their upstream licenses in the generated
`THIRD-PARTY-NOTICES.txt`. This package does not grant rights to redistribute
AgenticDeck itself.
