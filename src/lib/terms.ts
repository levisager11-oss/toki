// Changes to the terms of service, each announced in a Toki update at least 14 days before it
// applies (CLAUDE.md). Until a change's day the terms page shows the text without it, with a note
// about it; from that day on it shows the new text, by itself, with that day as its date. No
// database or browser code here, so the server can use it too.

export interface TermsChange {
  /** what changes, for the code that waits for it */
  id: "reports" | "tokens";
  /** the day it was announced in Toki's updates */
  announced: string;
  /** the day it applies (Swiss time, from midnight), as "YYYY-MM-DD" */
  date: string;
}

/** Every announced change, oldest first. */
export const TERMS_CHANGES: TermsChange[] = [
  // An admin can let an AI take a first look at a report (Toki 1.22).
  { id: "reports", announced: "2026-11-13", date: "2026-11-28" },
  // Toki Tokens and cosmetics: no money value, trading only between friends on Toki (Toki 1.25).
  { id: "tokens", announced: "2026-11-20", date: "2026-12-05" },
];

/** Midnight in Switzerland (UTC+1 in winter) is 23:00 UTC the day before. */
function from(date: string): number {
  return Date.parse(`${date}T00:00:00+01:00`);
}

/** Whether the change applies already. */
export function termsApply(id: TermsChange["id"], now: Date = new Date()): boolean {
  const change = TERMS_CHANGES.find((c) => c.id === id);
  return !!change && now.getTime() >= from(change.date);
}

/** The changes that don't apply yet, soonest first. */
export function comingTerms(now: Date = new Date()): TermsChange[] {
  return TERMS_CHANGES.filter((c) => now.getTime() < from(c.date));
}

/** The day of the latest change that applies, or null when none does yet. */
export function termsDate(now: Date = new Date()): string | null {
  const done = TERMS_CHANGES.filter((c) => now.getTime() >= from(c.date));
  return done.length ? done[done.length - 1].date : null;
}

/** The day the change about reports applies. */
export const TERMS_NEXT_DATE = TERMS_CHANGES[0].date;

/** Whether the change about reports applies already (the AI's first look at reports waits for it). */
export function nextTermsApply(now: Date = new Date()): boolean {
  return termsApply("reports", now);
}
