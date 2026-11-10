/**
 * Toki's address for links people share (share button, invites, prompts, pull requests).
 * It forwards to www.playtoki.app, so calls that send a key or a body (uploads, webhooks)
 * keep using the www address or the page's own origin.
 */
export const SITE_URL = "https://playtoki.app";
