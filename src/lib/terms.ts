// A change to the terms of service, announced in a Toki update at least 14 days before it applies
// (CLAUDE.md). Until TERMS_NEXT_DATE the terms page shows the current text with a note about the
// change; from that day on it shows the new text, by itself, with that day as its date. No
// database or browser code here, so the server can use it too.

/** The day the next terms apply (Swiss time, from midnight), as "YYYY-MM-DD". */
export const TERMS_NEXT_DATE = "2026-11-28";

/** Whether the next terms apply already. */
export function nextTermsApply(now: Date = new Date()): boolean {
  // Midnight in Switzerland (UTC+1 in winter) is 23:00 UTC the day before.
  return now.getTime() >= Date.parse(`${TERMS_NEXT_DATE}T00:00:00+01:00`);
}
