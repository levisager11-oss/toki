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
5. Play together (only if the game has online multiplayer with rooms that others join with a code or a link). Toki doesn't replace the game's multiplayer: it only brings a player's Toki friends into the same room.
   - When the player has opened or joined a room, call \`window.toki?.room(code)\` with the room's code, the same one the game shows or puts in its invite link. Call \`window.toki?.room(null)\` when they leave the room or it closes. Toki then offers "Invite friends" next to the game.
   - When a friend accepts, Toki opens the game with the code in its address: \`?room=CODE\` (the developer can set another name than \`room\` in the game's form on Toki, to match invite links the game already has). On start, read it with \`new URLSearchParams(location.search).get("room")\` and take the player straight into that room, or as close as the game allows (e.g. the join screen with the code filled in, if a name has to be picked first). If the game already reads such a code from its address, keep that and only add the \`toki.room\` calls.
   - Let Toki open a room: call \`window.toki?.onHost(fn)\` once when the game has loaded, if it can open a room without the player choosing anything first. Toki calls \`fn\` when the player invites friends before a room is open (at any time: on the title screen, or in a single-player round). In \`fn\`, do what the game's "host" or "create room" button does, with sensible defaults, and call \`window.toki?.room(code)\` as soon as the room has its code, as always. If the player is already in a room, do nothing. Leave \`onHost\` out if opening a room needs a choice from the player that has no default.
   - Room codes may only use letters, digits, "-" and "_" (at most 32 characters). For Godot, use JavaScriptBridge for both calls.
6. Don't change anything else. Outside Toki the script does nothing.

Script:
${scriptTag(script)}
`;
}
