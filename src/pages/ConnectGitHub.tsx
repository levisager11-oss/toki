import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { githubConnect, githubStateMatches } from "../lib/ai";

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
      .then(() => navigate("/connect", { replace: true, state: { github: "done" } }))
      .catch(() => setState("failed"));
  }, [params, navigate]);

  return (
    <div className="msg">
      <p role="status">{t(state === "working" ? "connect.githubConnecting" : state === "requested" ? "connect.githubRequested" : "connect.githubFailed")}</p>
      {state !== "working" && <Link to="/connect" className="btn">{t("connect.back")}</Link>}
    </div>
  );
}
