import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { CloseIcon } from "./icons";

/** A game's screenshots: tap one to see it large. Arrow keys or swiping go to the next one. */
export function Screenshots({ shots, title }: { shots: string[]; title: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="shots">
        {shots.map((src, n) => (
          <a
            key={src}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              // Ctrl/Cmd-click still opens the picture in a new tab.
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              setOpen(n);
            }}
          >
            <img src={src} alt={t("game.screenshotN", { n: n + 1, title })} loading="lazy" decoding="async" />
          </a>
        ))}
      </div>
      {open !== null && <Viewer shots={shots} title={title} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Viewer({ shots, title, start, onClose }: { shots: string[]; title: string; start: number; onClose: () => void }) {
  const { t } = useI18n();
  const [i, setI] = useState(start);
  const ref = useRef<HTMLDialogElement>(null);
  const touchX = useRef<number | null>(null);
  const many = shots.length > 1;
  const go = (d: number) => setI((n) => (n + d + shots.length) % shots.length);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("no-scroll");
    };
    // Runs once while open; go() only uses the state setter.
  }, []);

  return (
    <dialog
      ref={ref}
      className="shot-viewer"
      aria-label={t("game.screenshotN", { n: i + 1, title })}
      onClose={onClose}
      onCancel={onClose}
      // A tap on the dark background closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        const from = touchX.current;
        touchX.current = null;
        if (from === null || !many) return;
        const dx = e.changedTouches[0].clientX - from;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      <img src={shots[i]} alt={t("game.screenshotN", { n: i + 1, title })} />
      <button type="button" className="shot-close" onClick={onClose} aria-label={t("shots.close")}><CloseIcon /></button>
      {many && (
        <>
          <button type="button" className="shot-nav prev" onClick={() => go(-1)} aria-label={t("shots.prev")}>‹</button>
          <button type="button" className="shot-nav next" onClick={() => go(1)} aria-label={t("shots.next")}>›</button>
          <span className="shot-count">{i + 1} / {shots.length}</span>
        </>
      )}
    </dialog>
  );
}
