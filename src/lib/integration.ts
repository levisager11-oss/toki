// How a game adds Toki features. Used for the "copy instructions for an AI agent" button and by
// Toki Connect, so both always say the same.

/** The script inline, ready to paste into a game's HTML <head>. */
export const scriptTag = (script: string) => `<script>\n${script.trim()}\n</script>`;

export function integrationGuide(script: string): string {
  return `Add Toki save support to this web game.

Why: Toki (a game website) shows this game in an iframe. iPhones delete the storage of sites shown inside other sites when the app closes, so progress gets lost. The script below sends the game's localStorage to Toki, which keeps the save (on the device and in the player's account) and gives it back next time.

Do this:
1. In the game's main HTML file (the page Toki opens), add the script below as an inline <script> inside <head>, before the game's own scripts. Copy it exactly.
2. If the game saves with localStorage, nothing else is needed.
3. If the game saves another way (IndexedDB, Godot user:// files, cookies, a server), also keep a copy of the save in localStorage under one key: write it there every time the game saves, and when the game starts, load from that key if it exists. For Godot, use JavaScriptBridge to call localStorage.
4. High scores (if the game has a score or a best time): when a round ends, call \`window.toki?.score(points)\`. For times, send milliseconds. Toki keeps each player's best and shows a leaderboard.
5. Don't change anything else. Outside Toki the script does nothing.

Script:
${scriptTag(script)}
`;
}
