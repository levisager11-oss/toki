import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { BOARD_NAME_MAX, boardIdFromName, boardProblem, MAIN, MAX_BOARDS, type Board, type BoardInput } from "../lib/boardRules";
import { gameBoards, saveBoards } from "../lib/boards";

type Draft = Board & {
  /** a new one: its id follows its name until the developer types one */
  fresh: boolean;
};

const empty = (): Draft => ({ id: "", name: "", name_de: null, score_order: "high", score_format: "points", fresh: true });

/**
 * For the game's developer, on its form: the game's high-score lists besides its main one (at
 * most 10), and what the main one is called. Saved on their own (not with the game's form), so the
 * scores on the boards that stay are kept.
 */
export function BoardsSetup({ gameId, mainName, mainNameDe }: { gameId: string; mainName?: string | null; mainNameDe?: string | null }) {
  const { t } = useI18n();
  const uid = useId();
  const [list, setList] = useState<Draft[] | null>(null);
  const [main, setMain] = useState({ name: mainName ?? "", name_de: mainNameDe ?? "" });
  // The ids saved on Toki: boards removed from the list lose their scores when saved.
  const [saved, setSaved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    gameBoards(gameId).then((rows) => {
      if (!alive) return;
      setList(rows.map((r) => ({ ...r, fresh: false })));
      setSaved(rows.map((r) => r.id));
    });
    return () => {
      alive = false;
    };
  }, [gameId]);

  if (!list) return null;

  const change = (i: number, patch: Partial<Draft>) => {
    setMsg("");
    setList((l) => l!.map((b, n) => {
      if (n !== i) return b;
      const next = { ...b, ...patch };
      if (next.fresh && patch.name !== undefined) next.id = boardIdFromName(next.name, l!.filter((_, m) => m !== i).map((x) => x.id));
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
  const lost = saved.filter((id) => !list.some((b) => b.id === id));

  const save = async () => {
    setErr("");
    setMsg("");
    const clean: BoardInput[] = list.map((b) => ({
      id: b.id.trim(), name: b.name.trim(), name_de: b.name_de?.trim() || null, score_order: b.score_order, score_format: b.score_format,
    }));
    const problem = boardProblem(clean);
    if (problem) return setErr(t(problem));
    setBusy(true);
    try {
      await saveBoards(gameId, [{ id: MAIN, name: main.name.trim(), name_de: main.name_de.trim() || null }, ...clean]);
      setSaved(clean.map((b) => b.id));
      setList((l) => l!.map((b) => ({ ...b, fresh: false })));
      setMsg(t("boards.setup.saved"));
    } catch {
      setErr(t("boards.err.save"));
    }
    setBusy(false);
  };

  return (
    <details className="helper-setup boards-setup" open={list.length > 0} onKeyDown={noSubmit}>
      <summary><b>{t("boards.setup.title")}</b>{list.length > 0 && <span className="sub"> · {list.length}/{MAX_BOARDS}</span>}</summary>
      <div className="ai-panel">
        <small>{t("boards.setup.lead")}</small>
        <div className="pair">
          <input aria-label={t("boards.setup.mainName")} placeholder={t("boards.setup.mainName")} value={main.name} maxLength={BOARD_NAME_MAX} onChange={(e) => setMain((m) => ({ ...m, name: e.target.value }))} />
          <input aria-label={t("boards.setup.mainNameDe")} placeholder={t("boards.setup.mainNameDe")} value={main.name_de} maxLength={BOARD_NAME_MAX} onChange={(e) => setMain((m) => ({ ...m, name_de: e.target.value }))} />
        </div>
        <small>{t("boards.setup.mainHelp")}</small>
        <ol className="board-edit">
          {list.map((b, i) => (
            <li key={i}>
              <div className="pair">
                <input aria-label={t("boards.setup.name")} placeholder={t("boards.setup.name")} value={b.name} maxLength={BOARD_NAME_MAX} onChange={(e) => change(i, { name: e.target.value })} />
                <input aria-label={t("boards.setup.nameDe")} placeholder={t("boards.setup.nameDe")} value={b.name_de ?? ""} maxLength={BOARD_NAME_MAX} onChange={(e) => change(i, { name_de: e.target.value })} />
              </div>
              <div className="pair">
                <select aria-label={t("form.scores")} value={b.score_order} onChange={(e) => change(i, { score_order: e.target.value as Board["score_order"] })}>
                  <option value="high">{t("form.scoreOrder.high")}</option>
                  <option value="low">{t("form.scoreOrder.low")}</option>
                </select>
                <select aria-label={t("boards.setup.format")} value={b.score_format} onChange={(e) => change(i, { score_format: e.target.value as Board["score_format"] })}>
                  <option value="points">{t("form.scoreFormat.points")}</option>
                  <option value="time">{t("form.scoreFormat.time")}</option>
                </select>
              </div>
              <div className="board-edit-foot">
                <label htmlFor={`${uid}-id-${i}`} className="sub">{t("boards.setup.id")}</label>
                <input
                  id={`${uid}-id-${i}`} className="board-id-input" value={b.id} maxLength={32} spellCheck={false} autoCapitalize="none" placeholder="hard"
                  onChange={(e) => change(i, { id: e.target.value.replace(/\s/g, ""), fresh: false })}
                />
                {i > 0 && <button type="button" className="linkish" onClick={() => up(i)}>{t("boards.setup.up")}</button>}
                <button type="button" className="linkish danger-text" onClick={() => remove(i)}>{t("boards.setup.remove")}</button>
              </div>
            </li>
          ))}
        </ol>
        {list.length < MAX_BOARDS && (
          <button type="button" className="btn" onClick={() => setList((l) => [...l!, empty()])}>{t("boards.setup.add")}</button>
        )}
        {lost.length > 0 && <p className="check warn">{t("boards.setup.removeWarn", { n: lost.length })}</p>}
        {msg && <p className="check good" role="status">{msg}</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? t("boards.setup.saving") : t("boards.setup.save")}</button>
          {saved.length > 0 && <Link to={`/connect?update=boards&game=${gameId}`} className="linkish">{t("boards.setup.connect")}</Link>}
        </div>
        <small>{t("boards.setup.json")}</small>
      </div>
    </details>
  );
}
