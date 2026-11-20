/** Where to go after logging in: a page on this site from ?next=, otherwise the home page. */
export function safeNext(next: string | null): string {
  // Browsers read a backslash like a slash: "/\host" is another site, like "//host".
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}
