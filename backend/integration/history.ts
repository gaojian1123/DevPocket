import type { EventPage, WireEvent } from "../src/protocol.js";

export async function readHistory(request: (route: string) => Promise<unknown>, sessionPath: string): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  let cursor = 0;
  for (let pages = 0; pages < 1000; pages++) {
    const page = await request(`${sessionPath}/events?after=${cursor}`) as EventPage;
    if (!Array.isArray(page.events) || !Number.isSafeInteger(page.cursor)) throw new Error("Invalid event page.");
    if (page.reset) events.length = 0;
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (page.cursor <= cursor && !page.reset) throw new Error("History cursor did not advance.");
    cursor = page.cursor;
  }
  throw new Error("History pagination exceeded its bound.");
}
