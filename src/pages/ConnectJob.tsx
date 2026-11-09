import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ApiError, answerJob, cancelJob, connectError, getJob, jobCost, runJob, usd, type ConnectError, type ConnectJob as Job, type JobMessage, type Question } from "../lib/ai";
import { featureKey, GitHubMark, JobBadge } from "./Connect";

/** One Toki Connect run: progress, the AI's questions, and the pull request (/connect/:id). */
export function ConnectJob() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  // Why the last step failed (the run waits for "Continue"), or "" while running.
  const [paused, setPausedCode] = useState<ConnectError | false>(false);
  const setPaused = (on: false) => setPausedCode(on);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [tick, setTick] = useState(0);
  const [cost, setCost] = useState(0);

  useEffect(() => {
    getJob(id).then(setJob).catch(() => setJob(null));
  }, [id]);

  // While the run is working, take its next step; each step makes at most one AI call.
  useEffect(() => {
    if (!job || job.status !== "working" || paused) return;
    let alive = true;
    const before = job.updated_at;
    runJob(job.id)
      .then((j) => {
        if (!alive) return;
        setJob(j);
        // Nothing changed: another tab or step is working on it. Look again in a moment.
        if (j.status === "working" && j.updated_at === before) setTimeout(() => alive && setTick((n) => n + 1), 4000);
      })
      .catch((e) => alive && setPausedCode(connectError(e instanceof ApiError ? e.message : "error")));
    return () => {
      alive = false;
    };
  }, [job?.id, job?.status, job?.updated_at, paused, tick]);

  useEffect(() => {
    if (job) jobCost(job.id).then(setCost).catch(() => {});
  }, [job?.id, job?.status, job?.updated_at]);

  if (job === undefined) return <p className="msg" aria-busy="true">{t("loading")}</p>;
  if (job === null)
    return (
      <div className="msg">
        <p>{t("notFound")}</p>
        <Link to="/connect" className="btn">{t("connect.back")}</Link>
      </div>
    );

  const lastQuestion = job.status === "question" ? [...job.messages].reverse().find((m) => m.kind === "question") : undefined;

  return (
    <section className="fb-board connect-job">
      <Link to="/connect" className="back">← {t("connect.back")}</Link>
      <h1 className="h">{job.repo}</h1>
      <p className="fb-meta">
        <JobBadge status={job.status} pr={!!job.pr_url} />
        <span>{job.features.map((f) => t(featureKey(f))).join(" + ")}</span>
        {cost > 0 && <span>{t("connect.cost", { amount: usd(cost) })}</span>}
      </p>

      <ol className="job-log">
        {job.messages.map((m, i) => (
          <JobEntry key={i} m={m} />
        ))}
      </ol>

      {job.status === "working" && (
        paused ? (
          <div className="check">
            <p>{t("connect.paused")} {paused !== "error" && t(`connect.err.${paused}`)}</p>
            <button type="button" className="btn" onClick={() => setPaused(false)}>{t("connect.continue")}</button>
          </div>
        ) : (
          <p className="job-working" role="status"><span className="dots-anim" aria-hidden="true"><i /><i /><i /></span>{t("connect.working")}</p>
        )
      )}

      {lastQuestion && lastQuestion.kind === "question" && (
        <Answers questions={lastQuestion.questions} onSend={(answers) => answerJob(job.id, answers).then((j) => { setJob(j); setPaused(false); })} />
      )}

      {job.status === "done" && job.pr_url && (
        <div className="check good job-done">
          <p>{t("connect.done")}</p>
          <a className="btn primary" href={job.pr_url} target="_blank" rel="noopener noreferrer"><GitHubMark />{t("connect.openPr")} ↗</a>
        </div>
      )}
      {job.status === "done" && !job.pr_url && (
        <div className="check good job-done">
          <p>{t("connect.already")}</p>
        </div>
      )}
      {job.status === "failed" && (
        <p className="check warn" role="alert">
          {t(`connect.err.${connectError(job.error)}`)}
          {job.error_detail && <small className="model-error-detail">{job.error_detail}</small>}
        </p>
      )}

      {(job.status === "working" || job.status === "question") && (
        <div className="actions">
          <button
            type="button"
            className="btn ghost-danger"
            disabled={cancelling}
            onClick={() => {
              if (!confirmCancel) return setConfirmCancel(true);
              setCancelling(true);
              setCancelError(false);
              cancelJob(job.id)
                .then(setJob)
                .catch(() => setCancelError(true))
                .finally(() => { setCancelling(false); setConfirmCancel(false); });
            }}
          >
            {confirmCancel ? t("connect.cancelSure") : t("connect.cancel")}
          </button>
          {confirmCancel && !cancelling && <button type="button" className="linkish" onClick={() => setConfirmCancel(false)}>{t("connect.keepRunning")}</button>}
          {cancelError && <p className="error" role="alert">{t("error")}</p>}
        </div>
      )}
    </section>
  );
}

function JobEntry({ m }: { m: JobMessage }) {
  const { t } = useI18n();
  switch (m.kind) {
    case "progress":
      return <li className="job-progress">{t(m.step === "read" ? "connect.progress.read" : "connect.progress.more", { n: m.count })}</li>;
    case "question":
      return (
        <li className="job-msg ai">
          <b>{t("connect.ai")}</b>
          {m.text && <p>{m.text}</p>}
          <ul>{m.questions.map((q) => <li key={q.id}>{q.text}</li>)}</ul>
        </li>
      );
    case "answer":
      return (
        <li className="job-msg you">
          <b>{t("connect.you")}</b>
          <ul>{m.answers.map((a) => <li key={a.id}><span className="sub">{a.question}</span><br />{a.answer}</li>)}</ul>
        </li>
      );
    case "done":
      return (
        <li className="job-msg ai">
          <b>{t("connect.ai")}</b>
          <p className="fb-body">{m.text}</p>
          {m.files.length > 0 && (
            <>
              <span className="label">{t("connect.changed")}</span>
              <ul className="job-files">{m.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
            </>
          )}
        </li>
      );
    case "impossible":
      return (
        <li className="job-msg ai">
          <b>{t("connect.ai")}</b>
          <p className="fb-body">{m.text}</p>
        </li>
      );
  }
}

/** The AI's questions: pick an option or write an answer. */
function Answers({ questions, onSend }: { questions: Question[]; onSend: (a: { id: string; answer: string }[]) => Promise<void> }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const OTHER = "\u0000other";

  const value = (q: Question) => (picked[q.id] === OTHER || !q.options?.length ? other[q.id] ?? "" : picked[q.id] ?? "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(false);
    try {
      await onSend(questions.map((q) => ({ id: q.id, answer: value(q).trim() })));
    } catch {
      setErr(true);
      setBusy(false);
    }
  };

  return (
    <form className="form fb-form job-answers" onSubmit={submit}>
      <h2>{t("connect.status.question")}</h2>
      {questions.map((q) => (
        <fieldset key={q.id}>
          <legend>{q.text}</legend>
          {q.options?.length ? (
            <>
              {q.options.map((o) => (
                <label key={o} className="fb-check">
                  <input type="radio" name={q.id} checked={picked[q.id] === o} onChange={() => setPicked({ ...picked, [q.id]: o })} />
                  <span>{o}</span>
                </label>
              ))}
              <label className="fb-check">
                <input type="radio" name={q.id} checked={picked[q.id] === OTHER} onChange={() => setPicked({ ...picked, [q.id]: OTHER })} />
                <span>{t("connect.otherAnswer")}</span>
              </label>
              {picked[q.id] === OTHER && (
                <input aria-label={`${t("connect.yourAnswer")}: ${q.text}`} maxLength={500} value={other[q.id] ?? ""} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} autoFocus />
              )}
            </>
          ) : (
            <textarea aria-label={`${t("connect.yourAnswer")}: ${q.text}`} rows={2} maxLength={500} value={other[q.id] ?? ""} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} />
          )}
        </fieldset>
      ))}
      {err && <p className="error" role="alert">{t("error")}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{t("connect.send")}</button>
      </div>
    </form>
  );
}
