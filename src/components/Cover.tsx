import { useEffect, useRef, useState } from "react";
import { coverFor, drawCover } from "../pixel/scenes";

interface Props {
  slug: string;
  cover: string | null;
  image?: string | null;
  alt?: string;
  wide?: boolean;
  className?: string;
  /** "hover": moves while the pointer is over the surrounding card. "always": keeps moving. */
  animate?: "hover" | "always";
}

const FRAME_MS = 140;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Shows the uploaded image if there is one, otherwise a pixel scene.
export function Cover({ slug, cover, image, alt = "", wide, className, animate }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);
  const name = coverFor(slug, cover);
  const w = wide ? 160 : 64, h = wide ? 80 : 48;

  // Hover is tracked on the whole card, not just the picture.
  useEffect(() => {
    if (animate !== "hover" || image || !ref.current) return;
    const host = ref.current.closest(".card, .ritem, .cover-pick button") ?? ref.current;
    const on = () => setHovered(true), off = () => setHovered(false);
    host.addEventListener("pointerenter", on);
    host.addEventListener("pointerleave", off);
    return () => {
      host.removeEventListener("pointerenter", on);
      host.removeEventListener("pointerleave", off);
    };
  }, [animate, image]);

  const moving = !image && (animate === "always" || (animate === "hover" && hovered));

  useEffect(() => {
    const canvas = ref.current;
    if (image || !canvas) return;
    drawCover(canvas, name, slug, w, h);
    if (!moving || reducedMotion()) return;
    let frame = 0;
    const id = setInterval(() => {
      if (document.hidden) return;
      drawCover(canvas, name, slug, w, h, ++frame);
    }, FRAME_MS);
    return () => {
      clearInterval(id);
      drawCover(canvas, name, slug, w, h);
    };
  }, [image, name, slug, w, h, moving]);

  if (image) return <img className={`cover ${className ?? ""}`} src={image} alt={alt} loading="lazy" decoding="async" />;
  return <canvas ref={ref} width={w} height={h} className={`cover pixel ${className ?? ""}`} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
}
