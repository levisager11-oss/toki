import { useMemo } from "react";
import { pixelAvatar } from "../lib/avatar";

/** A player's picture: their upload, or their pixel avatar. */
export function Avatar({
  person,
  size = 32,
  online,
}: {
  person: { username: string; avatar_url?: string | null; avatar_seed?: string | null } | null | undefined;
  size?: number;
  /** shows a green dot */
  online?: boolean;
}) {
  const seed = person?.avatar_seed || person?.username || "";
  const px = useMemo(() => pixelAvatar(seed), [seed]);
  const style = { width: size, height: size };
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {person?.avatar_url ? (
        <img src={person.avatar_url} alt="" width={size} height={size} loading="lazy" decoding="async" />
      ) : (
        <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges">
          <rect width="8" height="8" fill={px.bg} />
          {px.cells.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={px.fg} /> : null)))}
        </svg>
      )}
      {online && <i className="online-dot" />}
    </span>
  );
}
