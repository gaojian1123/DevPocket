# Apple client implementation handoff

## Start here

This is the selected **Glass Workbench** design for iPhone, iPad, Mac and
iPhone Duo. It is an implementation reference, not a shipping Apple app or proof
of native acceptance. No previous design conversations or alternative layouts
are needed.

The first native offline milestone now lives in
`apple/DevPocket/DevPocket.xcodeproj`; see [Apple setup](../README.md#apple-native-offline-milestone).
The confirmed deployment targets are iOS/iPadOS 27.0 and macOS 27.0. Duo's
reserved-region APIs remain availability-gated to iOS 27.1 or later. The native
milestone uses only local fictional fixtures, not pairing or real runtime traffic.
The design reference and native verification remain distinct.
The native workbench omits the prototype's fixed promotional entry card.
Open examples through the normal session list; host context and search remain.
The native session-library organization below supersedes the prototype's
platform-specific navigation. The prototype remains an unchanged visual and
conversation reference, not a source of additional navigation controls.

Read `AGENTS.md`, the product sections of `README.md`, and `VALIDATION.md`
before implementation. This document defines the product design; it does not
override repository development rules or authorize deployment, installation,
pairing, publishing, or control of a real GitHub Copilot session.

The runnable reference is `docs\prototypes\apple-client\index.html`. From that
directory, run:

```sh
node serve.mjs
```

Open the loopback URL printed by the server. Follow the current README's
Node.js 26.12.1+ / npm 12.2.1 toolchain; the preview itself needs no dependency installation or build.
The server serves only its four local assets, denies application network
connections, and refuses production mode. It does not expose the repository.
The prototype directory contains only:

- `index.html`: preview page and device frames.
- `base.css`: shared typography, surfaces and controls.
- `app.css`: the selected client layout and device adaptation.
- `app.js`: mock data and in-memory interaction behavior.
- `serve.mjs`: loopback-only preview server.

Use `?device=iphone`, `ipad`, `mac` or `duo` to focus a device; omit it for all
devices. Other useful URL parameters:

- `pose=outer|open|book`: Duo outer display, fully open inner landscape, or
  book-like partial fold.
- `reader=1`: open a sample Canvas reader.
- `theme=light|dark`, `transparency=reduced`, `offline=1`.
- `narrow=1`: narrow iPad window.
- `scene=visual|plain|decision|legacy|building|unavailable|append`: mixed content,
  ordinary conversation, pending decisions, unassigned history, generation,
  unavailable Canvas, or a later appended chart.

All fixture data is invented. Settings, drafts and simulated receipts reset on
reload. The preview toolbar, device frames, state inspector and simulation
buttons are design tools, not controls to ship in the client.

## Native direction

Use SwiftUI for the application shell, navigation, conversation, composer,
permissions and questions. Use system typography, SF Symbols, safe areas and
native adaptive containers rather than reproducing every CSS measurement.
Keep the Mac experience a desktop workspace, not a scaled phone screen.

Liquid Glass belongs to navigation and controls. Chat text, code, tables,
permission details and chart data use legible content surfaces. Support light,
dark and system appearance, reduced transparency, increased contrast, Dynamic
Type, VoiceOver and keyboard navigation.

Do not package this entire HTML prototype inside a WebView as the application.
A restricted, offline WKWebView hosting the repository's component renderer is
compatible with a native shell; it is distinct from wrapping the prototype.

**Custom transition animation is deferred.** Do not add a custom folding,
unfolding or card-morph animation as part of the initial implementation.
Use normal platform behavior and respect Reduce Motion. Do not claim smooth
folding or native rendering performance from this HTML reference.

## Layout and navigation

### Shared session library

Keep the same reachable capabilities on every Apple layout: all sessions,
pinned, attention, archived, projects and computers. Share the collection/query
model and metadata actions; adapt their presentation to the platform rather
than implementing separate feature sets.

Projects and computers are independent filters and may be combined with search.
Search includes the session title, project, computer and branch. Pin, rename,
archive and restore affect DevPocket metadata only. Archived sessions remain
available in the library; unresolved decisions, failures and uncertain operations
also remain in Attention. Opening an attention item returns to its original
conversation entry without submitting or confirming it.

Use one hierarchy: **session list → conversation**. The session list is the
sidebar, not a second column behind a permanent collection/project/computer list.
Its scope menu switches all, pinned, attention and archived; its search and
filters narrow by project and computer. Keep a visible attention shortcut.
A wide window displays the list and conversation; a compact window navigates
between them. Do not nest another adaptive app tab/sidebar around the split view.
The main content always displays the conversation and composer. Attach the
native inspector inside the shared detail navigation content, including the
narrow Mac navigation-stack path, rather than outside the entire navigation
structure. The navigation toolbar spans the conversation and inspector; only
the content below it divides when the inspector opens. Preserve the conversation's
usable width and use native adaptation when all panes do not fit.

On iOS, use the system navigation title with a constant `.inlineLarge` display
mode. Keep its leading title treatment whether the sidebar or inspector is open
or closed; do not switch title modes, add a custom principal title, measure its
position, or implement a separate title animation or content-header row. Let the
system handle title sizing, truncation and accessibility. Keep the native Mac
title and subtitle unchanged.

On all platforms, Files and Changes are standard `.toggleStyle(.button)`
controls in one persistent `ToolbarItemGroup`. Declare this workbench toolbar
once, outside the inspector's content builder. Do not remove or transfer the
group when the inspector opens. Selecting the other item switches content;
selecting the active item closes the inspector. At a fixed window size, opening
the inspector must not move these controls to a different toolbar or inset them
by the inspector's width.

A wide inspector contains only its read-only content: no second navigation
stack, workspace toolbar or duplicate segmented selector. Compact sheet
presentations have their own native header with a Files/Changes segmented
`Picker` and an explicit Close button, because the underlying workbench toolbar
is covered. Selecting the current segment does not close the sheet. Use the same
presentation binding for Close, native dismissal and accessibility escape.

Let the system provide selection appearance, sizing and the shared glass
background. Do not draw a custom selection fill or force the same button dimensions
across platforms, and do not add device-family-specific positioning branches.
Compact layouts use the system's sheet adaptation of the inspector, with a
visible native drag indicator and interactive swipe dismissal in addition to
the explicit Close button. Provide the native accessibility escape action as
another dismissal path.
The component reader always opens as a modal, not a library destination or
a replacement for the session list.
Closing it preserves library scope, search, filters, draft and reading position.

Settings is an application-level utility with one primary entry: the native
Settings menu command on Mac, or the session-list actions menu
on iPhone/iPad. It is not repeated in conversation or
reader toolbars. The shared form opens as a Mac Settings window or mobile sheet.
Archive restoration belongs to the session library, not Settings.
Local examples identify their fictional project and computer. Existing saved
examples and drafts are not silently reset when new sample contexts are added.
The session-list actions menu also has an **Add computer** entry. In the offline milestone
it opens a native pairing page that clearly states real pairing is not yet
available; it does not collect credentials, scan a code or add a fictitious
successful connection. Real pairing remains a separate implementation stage.

Search and filters belong to the session library, not the selected conversation.
On Mac, place an AppKit search field and native filter menu above the session
list, inside that column rather than the shared window toolbar. Command-K reveals
and focuses that field even when a narrow window currently shows a conversation.
Mobile list navigation keeps its native search presentation and contextual filter.
Use the native sidebar material and selection treatment for the session list,
without an opaque background covering the entire navigation column. Preserve the system's
vertical arrangement where provided instead of forcing phone-style coordinates.

### iPhone

Search or filter the session list, then open a session into a single-column
conversation with its composer. Keep top-level navigation
separate from the session's conversation, files and read-only changes.

Canvas detail is a modal reader with one Close action, a centered compact title
and a continuous top background. There is no duplicate Back/Cancel action.
Read-only/source metadata belongs below the toolbar. Closing does not cancel
runtime work, discard a draft or lose the original reading position.

### iPad and Mac

Use the available width for session list/detail panes. Opening a Canvas always
presents a modal reader with one Close action, including on wide iPad and Mac
windows. It never moves the conversation into the session-list column or changes
sidebar visibility. Closing restores the original reading context and draft.
Mac keeps desktop toolbars and keyboard search.
Use the native detail title/subtitle and the shared Files/Changes toolbar group
instead of a conversation/files/changes picker. The group stays in the shared
toolbar during inspector presentation; the conversation remains visible.
On Mac, the window toolbar has no separate background in either inspector state.
Keep the shared toolbar's background visibility hidden so the workbench
background remains continuous; the inspector has no separate navigation toolbar. Preserve
the native title/subtitle and the two items' system glass backgrounds; do not
replace the title or add placeholder controls to influence bar appearance.

Prefer system sidebar translucency and native Liquid Glass controls, with a
floating composer over the conversation. Keep text, code and chart surfaces
legible; do not blur every content card or simulate glass with a fixed tint.
Reduce Transparency retains opaque readable controls.
On iPad, apply native translucent navigation-container materials rather than
covering the sidebar with solid header/footer backgrounds. The material adapts
to the platform, appearance and backdrop; it need not match Mac wallpaper
vibrancy pixel for pixel.
Use the system's native column background for wide inspectors, without adding
a material behind their content. The shared iOS inspector content declares
`presentationBackground` with `thinMaterial` for its sheet adaptation, falling
back to an opaque background with Reduce Transparency. Do not layer another
material inside the sheet. Its read-only list keeps its scroll and row backgrounds
clear. This presentation modifier does not specify the wide column's background;
the existing native Mac inspector material also remains unchanged.
The main workbench has one continuous decorative backdrop beneath the
conversation and both side panels, using the existing system canvas and a
restrained wash of the application accent. Navigation containers must not
replace it with independent opaque fills. The backdrop has no hit testing or
accessibility elements and never duplicates chat, WebKit or composer content.
Only that decorative backdrop receives the native background-extension effect,
not the interactive conversation. Reduce Transparency and Increased Contrast
use the plain system canvas and disable the extension effect.

### iPhone Duo

The preview covers the compact outer display, the inner display in landscape,
and a book-like partial fold. The outer display is single-pane; the inner
display can show the session list with the conversation and its optional
inspector. Canvas detail remains a modal overlay. Keep the selected session, drafts, card references,
chart/table view state and reading context across pose changes.

For the fully open list/detail layout, prefer a narrow list and wider chat:
approximately **30/70 of the content area** in this prototype. Treat this as a
width preference with suitable minimum/ideal/maximum widths, not an exact native
percentage guarantee. Opening a component must not change this arrangement.

In the outer display and inner landscape, follow the platform's vertical
navigation/toolbars. The preview puts them on the right; native placement must
follow the system, including other orientations and multitasking.

In a partial fold, let the panels adjust around actual reserved regions rather
than forcing 30/70 through the fold. Keep independent panels and important
controls out of the curved region. Prefer native adaptive containers and safe
areas; do not copy the mock hardware dimensions or hardcoded hinge width.

Inner portrait, tabletop poses, multi-app Split View, keyboard presentation and
native sheets are not demonstrated here. They require native design and
validation, not an assumption that the three mock poses cover every configuration.

## Conversation and Canvas behavior

- Read requests, assistant text, public tool activity, Canvas blocks and final
  text chronologically. Keep separate blocks and statuses; do not concatenate
  them into a single rewritten reply or duplicate the final text.
- There is no fixed "current turn" locator and no preset follow-up suggestion
  row. In the prototype, a fresh sample starts at its request. A real client
  should preserve an existing reading position and not jump to a chart merely
  because a new block arrived.
- A new independent user request starts a new response group. Answers and
  permissions belong to their original request. Group only when runtime origin
  evidence supports the association; keep unproven history independent.
- Pending decisions, errors and uncertain outcomes cannot be hidden by collapsing
  Canvas content. A generation-start event is not a completed component.
- Inline Canvas blocks can expand, collapse and return to their specific source
  reply, even after later requests. Sorting, filtering and time-range selection
  are local view state and do not change generated data.
- Components are append-only. A request to change a chart adds a new card in
  the later reply; the earlier chart remains intact.
- "Ask about this card" adds a removable explicit reference while preserving
  existing draft text. It never sends automatically. Sending requires the
  normal composer action and the current account/host/session scope.
- Nonblank text chooses Send, including during runtime work. With no text, a
  running/waiting/cancellation-requested session can show Stop. Confirm Stop and
  show cancellation requested until runtime evidence confirms it.
- Offline history and already received components remain readable. Drafts may
  be edited but are not automatically submitted on reconnect. Keep unconfirmed
  answers, approvals and deliveries visibly distinct from success.

## Reuse the product baseline

The repository already includes component transport, response association and an
Android implementation. Do not start by inventing another AgenticDeck protocol
or assuming these capabilities are absent.

Read these implementation surfaces:

- `backend\src\protocol.ts`: wire events, capability negotiation, ready/unavailable
  component records, command references and receipts.
- `backend\src\components.ts`: provider/canvas identity checks, successful tool
  result association, privacy projection, bounded records and reference lookup.
- `packages\components\README.md`, `src\spec.ts`, `src\renderer.ts` and `src\web.ts`:
  the independently authored data contract and offline renderer.
- `android\app\src\main\java\dev\devpocket\app\data\Components.kt`,
  `Wire.kt` and `LocalStore.kt`: native state, byte/digest validation and cache.
- `android\app\src\main\java\dev\devpocket\app\ui\ComponentView.kt` and
  `SessionPane.kt`: current restricted host integration and conversation behavior.

The supported component subset is `line`, `bar`, `datagrid` and `markdown`,
not arbitrary Canvas, HTML or JavaScript. Follow current package limits and
validate the exact canonical bytes/digest; do not reserialize a payload and
assume its checksum remains equivalent.

For a WKWebView adapter, use bundled trusted assets and the documented narrow
host bridge. Validate origin, main frame, active view and request identity;
restrict resource loading/navigation independently of CSP. Require native
confirmation for external links. Enable native card-reference controls only
after the matching renderer success; disable them after a render failure.

On Send, the existing bridge resolves a same-session component reference and
digest, then stages safe content as a private attachment for the original
runtime. It consumes one of four attachment positions. Do not replace that
contract with a title-only reference, silently lose it on retry, or count it as
an independent user-authored attachment upload.

Keep the existing `components=1` negotiation, bounded transport, legacy fallback,
redaction, ownership and replay rules. The prototype's local sample states are
not substitutes for those rules. Consult current source when details differ.

## Implementation boundaries and acceptance

An Apple build environment needs macOS and Xcode. Resolve deployment targets
before creating the native project; availability-guard newer APIs. Duo-specific
reserved-region/arrangement APIs are documented for iOS 27.1+, whereas standard
split-view width preferences have earlier availability.

First reproduce the native UI with explicitly labeled fixtures. Then connect
the current protocol and shared component contract, maintaining the existing
runtime identity and authorization model. Do not add automatic session creation,
Git writes, unrestricted file access, incomplete remote approvals or an editable
AgenticDeck data grid.

Verify native navigation, narrow windows, large text, input/keyboard behavior,
reader dismissal, card references, identity-bound recovery and offline states
on the intended platforms. Device pose and simulator checks are not physical
folding, touch or performance acceptance. Native UI coverage should retain the
confirmed single-close reader, no fixed turn locator, no generated suggestions,
and append-only card behavior.

APNs, release signing, distribution, physical-device acceptance, production
enrollment and real-runtime exercises are not implemented or authorized by this
handoff. Follow the repository's verification and separately scoped operation
requirements during implementation. The native offline milestone does not turn
this design reference into a connected or application-verified iOS release.

## Primary design references

- [Apple materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo)
- [Design for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111466/)
- [NavigationSplitView column sizing](https://developer.apple.com/documentation/swiftui/navigationsplitview#Customize-a-split-view)
