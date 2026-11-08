import { useEffect, type RefObject } from "react";

// iPhones sometimes leave a bar pinned to the bottom floating in the middle of the screen,
// mostly in the home-screen app after the keyboard closes: iOS keeps the screen height
// shrunk to what it was with the keyboard open. This hook hides the bar while typing and,
// once the keyboard is gone, moves the bar back to the real bottom edge if iOS got it wrong.

const isTyping = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
};

export function useBottomBarFix(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vv = window.visualViewport;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    // Tallest screen height seen for each screen width (one per orientation). In the
    // home-screen app the height never changes on purpose, so a smaller value is the bug.
    const tallest = new Map<number, number>();
    let raf = 0;
    let timer = 0;

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const typing = touch && isTyping();
        el.classList.toggle("kb-open", typing);
        if (typing) {
          el.style.transform = "";
          return;
        }
        const h = window.innerHeight;
        let shift = 0;
        // Gap between the bottom of what is visible and the bottom the bar is pinned to.
        if (vv && vv.scale <= 1.01) shift = vv.offsetTop + vv.height - h;
        if (standalone) {
          const w = window.innerWidth;
          const max = Math.max(tallest.get(w) ?? 0, h);
          tallest.set(w, max);
          if (max - h > 100) shift = Math.max(shift, max - h);
        }
        el.style.transform = shift > 1 ? `translateY(${Math.round(shift)}px)` : "";
      });
    };

    // A tiny scroll makes iOS measure the screen again, which often clears the bug by itself.
    const nudge = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isTyping()) return;
        const { scrollX: x, scrollY: y } = window;
        window.scrollTo(x, y > 0 ? y - 1 : y + 1);
        window.scrollTo(x, y);
        update();
        setTimeout(update, 300);
      }, 250);
    };

    const onFocusIn = () => update();
    const onVisible = () => document.visibilityState === "visible" && nudge();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", nudge);
    window.addEventListener("pageshow", nudge);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", nudge);
    document.addEventListener("visibilitychange", onVisible);
    update();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", nudge);
      window.removeEventListener("pageshow", nudge);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", nudge);
      document.removeEventListener("visibilitychange", onVisible);
      el.style.transform = "";
      el.classList.remove("kb-open");
    };
  }, [ref]);
}
