// Chat stickers: small pixel pictures drawn in the browser from these grids, so nothing has to
// be stored or downloaded. A pack is a cosmetic ("stickers.<pack>", bought in the shop); a
// message "[sticker:<pack>/<name>]" shows as the sticker, and the database lets only players who
// have the pack send one (messages_stickers in supabase/migrations/20261212090000_toki_tokens.sql).

const PALETTE: Record<string, string> = {
  R: "#e8384f", W: "#f6f6f6", Y: "#ffc531", K: "#1b1b1f", B: "#4fb3ff", P: "#9a7bff",
  O: "#ff9a3c", G: "#2fbf71", D: "#b8860b", S: "#f2b37b", N: "#ff8fb3",
};

// Each is 10 by 10: "." is see-through, a letter is a color above.
export const STICKER_PACKS: Record<string, Record<string, string[]>> = {
  pals: {
    heart: [
      "..........",
      ".RR....RR.",
      "RRRR..RRRR",
      "RWRRRRRRRR",
      "RRRRRRRRRR",
      ".RRRRRRRR.",
      "..RRRRRR..",
      "...RRRR...",
      "....RR....",
      "..........",
    ],
    star: [
      "....YY....",
      "....YY....",
      "...YYYY...",
      "YYYYYYYYYY",
      ".YYYYYYYY.",
      "..YYYYYY..",
      "..YYYYYY..",
      ".YYY..YYY.",
      ".YY....YY.",
      "..........",
    ],
    happy: [
      "..YYYYYY..",
      ".YYYYYYYY.",
      "YYKYYYYKYY",
      "YYKYYYYKYY",
      "YYYYYYYYYY",
      "YKYYYYYYKY",
      "YYKKKKKKYY",
      ".YYYYYYYY.",
      "..YYYYYY..",
      "..........",
    ],
    sad: [
      "..YYYYYY..",
      ".YYYYYYYY.",
      "YYKYYYYKYY",
      "YYKYYYYKYY",
      "YBYYYYYYYY",
      "YBYKKKKYYY",
      "YYKYYYYKYY",
      ".YYYYYYYY.",
      "..YYYYYY..",
      "..........",
    ],
    ghost: [
      "...PPPP...",
      "..PPPPPP..",
      ".PPPPPPPP.",
      ".PWKPPWKP.",
      ".PWKPPWKP.",
      ".PPPPPPPP.",
      ".PPPNNPPP.",
      ".PPPPPPPP.",
      ".PP.PP.PP.",
      ".P..P..P..",
    ],
    cat: [
      ".O......O.",
      ".OO....OO.",
      ".OOOOOOOO.",
      "OOKOOOOKOO",
      "OOKOOOOKOO",
      "OOOONNOOOO",
      ".OOOKKOOO.",
      "..OOOOOO..",
      "...O..O...",
      "..........",
    ],
  },
  gg: {
    gg: [
      "..........",
      "..........",
      ".GGG..GGG.",
      "G....G....",
      "G.GG.G.GG.",
      "G..G.G..G.",
      ".GGG..GGG.",
      "..........",
      "..........",
      "..........",
    ],
    trophy: [
      "YYYYYYYYYY",
      "Y.YYYYYY.Y",
      "Y.YYYYYY.Y",
      ".YYYYYYYY.",
      "..YYYYYY..",
      "...YYYY...",
      "....DD....",
      "....DD....",
      "...DDDD...",
      "..DDDDDD..",
    ],
    fire: [
      "....R.....",
      "...RR.....",
      "...RRR..R.",
      "..RRORR.RR",
      ".RRROORRRR",
      ".RROOOORRR",
      "RROOYYOORR",
      "RROYYYYORR",
      ".ROYYYYOR.",
      "..RRRRRR..",
    ],
    crown: [
      "..........",
      "Y...YY...Y",
      "YY..YY..YY",
      "YYY.YY.YYY",
      "YYYYYYYYYY",
      "YRYYBYYRYY",
      "YYYYYYYYYY",
      "YYYYYYYYYY",
      "..........",
      "..........",
    ],
    skull: [
      "..WWWWWW..",
      ".WWWWWWWW.",
      "WWWWWWWWWW",
      "WKKWWWWKKW",
      "WKKWWWWKKW",
      "WWWWKKWWWW",
      ".WWWWWWWW.",
      "..WKWKWK..",
      "..WWWWWW..",
      "..........",
    ],
    thumbs: [
      "....SS....",
      "....SS....",
      "...SSS....",
      "..SSSS....",
      "SSSSSSSSS.",
      "SSSSSSSSSS",
      "SSSSSSSSS.",
      "SSSSSSSSS.",
      "SSSSSSSS..",
      "..........",
    ],
  },
};

/** The cells of a sticker to draw, or null for one that doesn't exist. */
export function stickerCells(pack: string, name: string): { x: number; y: number; color: string }[] | null {
  const grid = STICKER_PACKS[pack]?.[name];
  if (!grid) return null;
  return grid.flatMap((row, y) => [...row].flatMap((ch, x) => (PALETTE[ch] ? [{ x, y, color: PALETTE[ch] }] : [])));
}

const STICKER = /^\[sticker:([a-z0-9-]{1,20})\/([a-z0-9-]{1,20})\]$/;

/** A message that is a sticker: its pack and name. */
export function parseSticker(body: string): { pack: string; name: string } | null {
  const m = STICKER.exec(body.trim());
  return m && STICKER_PACKS[m[1]]?.[m[2]] ? { pack: m[1], name: m[2] } : null;
}

export const stickerMessage = (pack: string, name: string) => `[sticker:${pack}/${name}]`;
