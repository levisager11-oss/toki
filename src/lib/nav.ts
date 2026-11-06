/** Where to go after logging in: a page on this site from ?next=, otherwise the home page. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
