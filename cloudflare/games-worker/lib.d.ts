export function siteFrom(hostname: string, domain: string, reserved: Set<string>): string | null;
export function filePath(pathname: string): string | null;
export function typeOf(path: string): { type: string; encoding: "br" | "gzip" | null };
export function isHtml(path: string): boolean;
