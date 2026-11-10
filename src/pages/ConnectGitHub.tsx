import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { githubConnect, githubConnectLink, githubInfo, githubInstallLink, githubStateCheck } from "../lib/ai";

/** A page on Toki the developer came from (e.g. a game's edit page), else Toki Connect. */
const returnPath = (back: string | null) => (back && /^\/(edit\/|add$|add#|my-games)/.test(back) ? back : "/connect");

// Sent on to GitHub's install page once already in this visit (so it can't go in circles).
const INSTALL_TRIED = "toki.githubInstallTried";
const tried = () => {
  try {
    return Date.now() - Number(sessionStorage.getItem(INSTALL_TRIED) ?? 0) < 30 * 60_000;
  } catch {
    return true;
  }
};
const setTried = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(INSTALL_TRIED, String(Date.now()));
    else sessionStorage.removeItem(INSTALL_TRIED);
  } catch {
    /* only against going in circles */
  }
};

/**
 * Where GitHub sends the developer back (/connect/github), from its login page or after
 * installing the Toki app. Toki asks GitHub which installations this person can use:
 * - some: connected, back to where they came from.
 * - none: the app isn't on their GitHub account yet, so on to GitHub's install page (once).
 * GitHub's answer without a login code (the app was only changed there): on to the login page.
 */
export function ConnectGitHub() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<"working" | "requested" | "failed" | "notInstalled">("working");
  const [busy, setBusy] = useState(false);
  const once = useRef(false);
  const back = useRef<string | null>(null);

  /** Off to GitHub again: its login page, or its install page. */
  const go = async (where: "login" | "install") => {
    setBusy(true);
    try {
      const info = await githubInfo();
      if (!info.configured || !info.installUrl) throw new Error("off");
      if (where === "install") setTried(true);
      window.location.assign(where === "install" ? githubInstallLink(info.installUrl, back.current) : githubConnectLink(info, back.current));
    } catch {
      setBusy(false);
      setState("failed");
    }
  };

  useEffect(() => {
    if (once.current) return; // the code works only once
    once.current = true;
    if (params.get("setup_action") === "request") return setState("requested");
    const code = params.get("code");
    const check = githubStateCheck(params.get("state"));
    back.current = check.back;
    if (!code) {
      // GitHub came back without a login code (the app was installed or changed there): log in to finish.
      if (params.get("installation_id") && !params.get("error")) void go("login");
      else setState("failed");
      return;
    }
    // The state we sent must come back: the answer belongs to a visit started here.
    if (!check.ok) return setState("failed");
    githubConnect(code)
      .then((r) => {
        if (r.installations.length) {
          setTried(false);
          return navigate(returnPath(check.back), { replace: true, state: { github: "done" } });
        }
        // Logged in, but the Toki app isn't on any of their GitHub accounts yet: install it.
        if (tried()) return setState("notInstalled");
        return go("install");
      })
      .catch(() => setState("failed"));
  }, [params, navigate]);

  const text =
    state === "working" ? "connect.githubConnecting" : state === "requested" ? "connect.githubRequested" : state === "notInstalled" ? "connect.githubNotInstalled" : "connect.githubFailed";
  return (
    <div className="msg">
      <p role="status">{t(text)}</p>
      {state !== "working" && (
        <div className="actions">
          {state === "failed" && <button type="button" className="btn primary" onClick={() => go("login")} disabled={busy}>{t("tryAgain")}</button>}
          {state === "notInstalled" && <button type="button" className="btn primary" onClick={() => go("install")} disabled={busy}>{t("connect.githubInstall")}</button>}
          <Link to={returnPath(back.current)} className="btn">{t("connect.back")}</Link>
        </div>
      )}
    </div>
  );
}
