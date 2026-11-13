// Bot check (Cloudflare Turnstile) for sign-up, login and password reset. Supabase checks the token
// when "Captcha protection" is on in its Auth settings. Without VITE_TURNSTILE_SITE_KEY nothing is
// shown and no token is sent, so sign-up works as before.
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

const SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY || undefined;
/** Whether the bot check is set up (the privacy policy only mentions it then). */
export const CAPTCHA_ON = !!SITE_KEY;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface Turnstile {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error("turnstile"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** The bot check box, and a way to get a fresh token for each request (a token works only once).
 * `form`: change it when a different form (with its own box) is shown. */
export function useCaptcha(form = "") {
  const { lang } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const waiting = useRef<((t: string | undefined) => void)[]>([]);
  const [failed, setFailedState] = useState(false);
  const failedRef = useRef(false);
  const setFailed = (v: boolean) => {
    failedRef.current = v;
    setFailedState(v);
  };

  const settle = (t: string | undefined) => {
    token.current = t ?? null;
    const w = waiting.current;
    waiting.current = [];
    w.forEach((f) => f(t));
  };

  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    let gone = false;
    token.current = null;
    setFailed(false);
    const el = box.current;
    loadTurnstile()
      .then((ts) => {
        if (gone) return;
        widget.current = ts.render(el, {
          sitekey: SITE_KEY,
          language: lang,
          appearance: "interaction-only",
          callback: (t: string) => settle(t),
          "expired-callback": () => (token.current = null),
          "error-callback": () => {
            setFailed(true);
            settle(undefined);
          },
        });
      })
      .catch(() => {
        setFailed(true);
        settle(undefined);
      });
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
    // The language is read when the box is drawn; it isn't redrawn when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  /** A token for one request, or undefined when the check is off. Waits for the check to finish. */
  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!SITE_KEY || failedRef.current) return undefined;
    let t: string | null | undefined = token.current;
    if (!t) t = await new Promise<string | undefined>((res) => waiting.current.push(res));
    // Used up: ask for the next one now, so a second request (sign-up, then login) gets its own.
    token.current = null;
    if (widget.current) window.turnstile?.reset(widget.current);
    return t ?? undefined;
  }, []);

  const element = SITE_KEY ? <div ref={box} className="captcha" /> : null;
  return { element, getToken, failed, on: !!SITE_KEY };
}

/** Supabase's answer when the bot check is missing or didn't pass. */
export const isCaptchaError = (e: { message?: string } | null | undefined) => !!e?.message && /captcha/i.test(e.message);
