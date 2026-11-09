import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { githubConnect, githubStateMatches } from "../lib/ai";
import { GITHUB_RETURN_KEY } from "../lib/hosting";

/** A page on Toki the developer came from (e.g. a game's edit page), else Toki Connect. */
function returnPath(): string {
  try {
    const p = sessionStorage.getItem(GITHUB_RETURN_KEY);
    sessionStorage.removeItem(GITHUB_RETURN_KEY);
    if (p && /^\/(edit\/|add$)/.test(p)) return p;
  } catch {
    /* no session storage */
  }
  return "/connect";
}

/** Where GitHub sends the developer back after installing the Toki app (/connect/github). */
export function ConnectGitHub() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<"working" | "requested" | "failed">("working");
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // the code works only once
    once.current = true;
    if (params.get("setup_action") === "request") return setState("requested");
    const code = params.get("code");
    // The state we sent must come back: the answer belongs to this visit.
    if (!code || !githubStateMatches(params.get("state"))) return setState("failed");
    githubConnect(code)
      .then(() => navigate(returnPath(), { replace: true, state: { github: "done" } }))
      .catch(() => setState("failed"));
  }, [params, navigate]);

  return (
    <div className="msg">
      <p role="status">{t(state === "working" ? "connect.githubConnecting" : state === "requested" ? "connect.githubRequested" : "connect.githubFailed")}</p>
      {state !== "working" && <Link to="/connect" className="btn">{t("connect.back")}</Link>}
    </div>
  );
}
