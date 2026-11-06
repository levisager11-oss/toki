import { useEffect, useRef } from "react";
import { coverFor, drawCover } from "../pixel/scenes";

interface Props {
  slug: string;
  cover: string | null;
  image?: string | null;
  alt?: string;
  wide?: boolean;
  className?: string;
}

// Shows the uploaded image if there is one, otherwise a pixel scene.
export function Cover({ slug, cover, image, alt = "", wide, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const name = coverFor(slug, cover);
  useEffect(() => {
    if (!image && ref.current) drawCover(ref.current, name, slug, wide ? 160 : 64, wide ? 80 : 48);
  }, [image, name, slug, wide]);
  if (image) return <img className={`cover ${className ?? ""}`} src={image} alt={alt} loading="lazy" />;
  return <canvas ref={ref} className={`cover pixel ${className ?? ""}`} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
}
