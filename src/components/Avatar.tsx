import { useMemo } from "react";
import { pixelAvatar } from "../lib/avatar";
import { FrameRing, useFrameStyle } from "./Looks";

/** A player's picture: their upload, or their pixel avatar, in the frame they wear. */
export function Avatar({
  person,
  size = 32,
  online,
  frameId,
}: {
  person: { id?: string | null; user_id?: string | null; username: string; avatar_url?: string | null; avatar_seed?: string | null } | null | undefined;
  size?: number;
  /** shows a green dot */
  online?: boolean;
  /** for previews: this frame instead of the player's own (null: none) */
  frameId?: string | null;
}) {
  const seed = person?.avatar_seed || person?.username || "";
  const px = useMemo(() => pixelAvatar(seed), [seed]);
  const frame = useFrameStyle(person?.id ?? person?.user_id ?? null, frameId);
  const style = { width: size, height: size };
  return (
    <span className={`avatar${frame ? " framed" : ""}`} style={style} aria-hidden="true">
      {person?.avatar_url ? (
        <img src={person.avatar_url} alt="" width={size} height={size} loading="lazy" decoding="async" />
      ) : (
        <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges">
          <rect width="8" height="8" fill={px.bg} />
          {px.cells.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={px.fg} /> : null)))}
        </svg>
      )}
      <FrameRing style={frame} />
      {online && <i className="online-dot" />}
    </span>
  );
}
