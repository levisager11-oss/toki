import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import {
  achievementProblem, cleanIcon, cut, DEFAULT_ICON, DESCRIPTION_MAX, idFromName, MAX_ACHIEVEMENTS, NAME_MAX, type Achievement,
} from "../lib/achievementRules";
import { gameAchievements, saveAchievements } from "../lib/achievements";

type Draft = Achievement & {
  /** how many players have it (0 for new ones) */
  players: number;
  /** a new one: its id follows its name until the developer types one */
  fresh: boolean;
};

const empty = (): Draft => ({ id: "", name: "", name_de: null, description: "", description_de: null, icon: DEFAULT_ICON, players: 0, fresh: true });

/**
 * For the game's developer, on its form: the game's achievements (at most 30). Saved on their
 * own (not with the game's form), so players' unlocks of the ones that stay are kept.
 */
export function AchievementsSetup({ gameId }: { gameId: string }) {
  const { t } = useI18n();
  const uid = useId();
  const [list, setList] = useState<Draft[] | null>(null);
  // The saved ones, and how many players have each.
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    gameAchievements(gameId).then(
      (rows) => {
        if (!alive) return;
        setList(rows.map((r) => ({ ...r, fresh: false })));
        setSaved(Object.fromEntries(rows.map((r) => [r.id, r.players])));
      },
      () => alive && setList([]),
    );
    return () => {
      alive = false;
    };
  }, [gameId]);

  if (!list) return null;

  const change = (i: number, patch: Partial<Draft>) => {
    setMsg("");
    setList((l) => l!.map((a, n) => {
      if (n !== i) return a;
      const next = { ...a, ...patch };
      if (next.fresh && patch.name !== undefined) next.id = idFromName(next.name, l!.filter((_, m) => m !== i).map((x) => x.id));
      return next;
    }));
  };
  const remove = (i: number) => setList((l) => l!.filter((_, n) => n !== i));
  const up = (i: number) => setList((l) => {
    const next = [...l!];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    return next;
  });
  // Enter in a field would send the game's form around this.
  const noSubmit = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
  };
  // Saved ones that players have and that are no longer in the list: those players lose them.
  const lost = Object.entries(saved).filter(([id, n]) => n > 0 && !list.some((a) => a.id === id));

  const save = async () => {
    setErr("");
    setMsg("");
    const clean: Achievement[] = list.map((a) => ({
      id: a.id.trim(),
      name: a.name.trim(),
      name_de: a.name_de?.trim() || null,
      description: a.description.trim(),
      description_de: a.description_de?.trim() || null,
      icon: a.icon.trim() ? a.icon.trim() : DEFAULT_ICON,
    }));
    const problem = achievementProblem(clean);
    if (problem) return setErr(t(problem));
    setBusy(true);
    try {
      await saveAchievements(gameId, clean.map((a) => ({ ...a, icon: cleanIcon(a.icon) })));
      setSaved(Object.fromEntries(clean.map((a) => [a.id, saved[a.id] ?? 0])));
      setList((l) => l!.map((a) => ({ ...a, fresh: false })));
      setMsg(t("ach.setup.saved"));
    } catch {
      setErr(t("ach.err.save"));
    }
    setBusy(false);
  };

  return (
    <details className="helper-setup ach-setup" open={list.length > 0} onKeyDown={noSubmit}>
      <summary><b>{t("ach.setup.title")}</b>{list.length > 0 && <span className="sub"> · {list.length}/{MAX_ACHIEVEMENTS}</span>}</summary>
      <div className="ai-panel">
        <small>{t("ach.setup.lead")}</small>
        <ol className="ach-edit">
          {list.map((a, i) => (
            <li key={i}>
              <div className="ach-edit-head">
                <input
                  className="ach-icon-input" aria-label={t("ach.setup.icon")} value={a.icon} maxLength={16} placeholder={DEFAULT_ICON}
                  onChange={(e) => change(i, { icon: e.target.value })}
                />
                <input aria-label={t("ach.setup.name")} placeholder={t("ach.setup.name")} value={a.name} maxLength={NAME_MAX} onChange={(e) => change(i, { name: cut(e.target.value, NAME_MAX) })} />
              </div>
              <input aria-label={t("ach.setup.desc")} placeholder={t("ach.setup.desc")} value={a.description} maxLength={DESCRIPTION_MAX} onChange={(e) => change(i, { description: e.target.value })} />
              <div className="pair">
                <input aria-label={t("ach.setup.nameDe")} placeholder={t("ach.setup.nameDe")} value={a.name_de ?? ""} maxLength={NAME_MAX} onChange={(e) => change(i, { name_de: e.target.value })} />
                <input aria-label={t("ach.setup.descDe")} placeholder={t("ach.setup.descDe")} value={a.description_de ?? ""} maxLength={DESCRIPTION_MAX} onChange={(e) => change(i, { description_de: e.target.value })} />
              </div>
              <div className="ach-edit-foot">
                <label htmlFor={`${uid}-id-${i}`} className="sub">{t("ach.setup.id")}</label>
                <input
                  id={`${uid}-id-${i}`} className="ach-id-input" value={a.id} maxLength={32} spellCheck={false} autoCapitalize="none" placeholder="first-win"
                  onChange={(e) => change(i, { id: e.target.value.replace(/\s/g, ""), fresh: false })}
                />
                {a.players > 0 && <span className="sub">{t("ach.players", { n: a.players })}</span>}
                {i > 0 && <button type="button" className="linkish" onClick={() => up(i)}>{t("ach.setup.up")}</button>}
                <button type="button" className="linkish danger-text" onClick={() => remove(i)}>{t("ach.setup.remove")}</button>
              </div>
            </li>
          ))}
        </ol>
        {list.length < MAX_ACHIEVEMENTS && (
          <button type="button" className="btn" onClick={() => setList((l) => [...l!, empty()])}>{t("ach.setup.add")}</button>
        )}
        <small>{t("ach.setup.deHelp")}</small>
        {lost.length > 0 && <p className="check warn">{t("ach.setup.removeWarn", { n: lost.length })}</p>}
        {msg && <p className="check good" role="status">{msg}</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? t("ach.setup.saving") : t("ach.setup.save")}</button>
          {Object.keys(saved).length > 0 && <Link to={`/connect?update=achievements&game=${gameId}`} className="linkish">{t("ach.setup.connect")}</Link>}
        </div>
        <small>{t("ach.setup.json")}</small>
      </div>
    </details>
  );
}
