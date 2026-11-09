import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { ApiError, githubRepos, type GitHubInfo } from "../lib/ai";
import { assistError, gameHelp, saveGameHelp, useFreeAi, type GameHelp } from "../lib/assist";

/** For the game's developer: what the "Ask AI" helper knows (tips, and a guide learned from GitHub). */
export function HelperSetup({ gameId }: { gameId: string }) {
  const { t, lang } = useI18n();
  const id = useId();
  const on = useFreeAi();
  const [help, setHelp] = useState<GameHelp | null | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [repo, setRepo] = useState("");
  const [repos, setRepos] = useState<NonNullable<GitHubInfo["repos"]> | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "learn">("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!on) return;
    gameHelp(gameId)
      .then((h) => {
        setHelp(h);
        setNotes(h?.notes ?? "");
        setRepo(h?.repo && h.installation_id ? `${h.installation_id}|${h.repo}` : "");
      })
      .catch(() => setHelp(null));
    githubRepos().then((g) => setRepos(g.repos ?? [])).catch(() => setRepos([]));
  }, [on, gameId]);

  if (!on || help === undefined) return null;

  const save = async (learn: boolean) => {
    setBusy(learn ? "learn" : "save");
    setErr("");
    setDetail("");
    setMsg("");
    const [inst, name] = repo.split("|");
    try {
      const r = await saveGameHelp({ game_id: gameId, notes: notes.trim(), ...(name ? { installation_id: Number(inst), repo: name, learn } : {}) });
      setHelp((h) => ({
        notes: notes.trim(),
        installation_id: name ? Number(inst) : null,
        repo: name || null,
        guide: r.guide ?? (name ? h?.guide ?? "" : ""),
        learned_at: r.learned_at ?? (name ? h?.learned_at ?? null : null),
      }));
      setMsg(learn ? t("helper.setup.learned") : t("helper.setup.saved"));
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
      setDetail(e instanceof ApiError ? e.detail : "");
    }
    setBusy("");
  };
  const sameRepo = !!help?.repo && repo === `${help.installation_id}|${help.repo}`;

  return (
    <section className="ai-panel helper-setup" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="label"><span aria-hidden="true">✦ </span>{t("helper.setup.title")}</h2>
      <small>{t("helper.setup.lead")}</small>
      <label htmlFor={`${id}-n`}>{t("helper.setup.notes")}</label>
      <textarea id={`${id}-n`} rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("helper.setup.notesPlaceholder")} />
      <label htmlFor={`${id}-r`}>{t("helper.setup.repo")}</label>
      {repos && repos.length > 0 ? (
        <select id={`${id}-r`} value={repo} onChange={(e) => setRepo(e.target.value)} aria-describedby={`${id}-rh`}>
          <option value="">{t("rel.ai.noRepo")}</option>
          {repos.map((r) => <option key={`${r.installation_id}|${r.repo}`} value={`${r.installation_id}|${r.repo}`}>{r.repo}{r.private ? " 🔒" : ""}</option>)}
        </select>
      ) : (
        <p className="hint" id={`${id}-r`}>{t("helper.setup.noGithub")} <Link to="/connect">{t("nav.connect")}</Link></p>
      )}
      <small id={`${id}-rh`}>{t("helper.setup.repoHelp")}</small>
      {help?.learned_at && sameRepo && (
        <p className="sub">
          {t("helper.setup.learnedAt", { when: ago(help.learned_at, lang) })}{" "}
          <button type="button" className="linkish" onClick={() => setShowGuide((v) => !v)} aria-expanded={showGuide}>{showGuide ? t("helper.setup.hideGuide") : t("helper.setup.showGuide")}</button>
        </p>
      )}
      {showGuide && help?.guide && <pre className="helper-guide">{help.guide}</pre>}
      {msg && <p className="check good" role="status">{msg}</p>}
      {err && (
        <p className="error" role="alert">
          {err}
          {detail && <small className="model-error-detail">{detail}</small>}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => save(false)} disabled={!!busy}>{busy === "save" ? t("rel.form.saving") : t("helper.setup.save")}</button>
        {repo && (
          <button type="button" className="btn" onClick={() => save(true)} disabled={!!busy}>
            {busy === "learn" ? t("helper.setup.learning") : sameRepo && help?.learned_at ? t("helper.setup.relearn") : t("helper.setup.learn")}
          </button>
        )}
      </div>
    </section>
  );
}
