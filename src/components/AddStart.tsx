import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useAiFeature } from "../lib/assist";

/** The three ways to add a game, picked on Add game's first screen (src/pages/GameForm.tsx). */
export type AddStartChoice = "manual" | "ai" | "link";

/**
 * Add game's first screen: three equal ways in. "Fill it in myself" (the full form, no AI reads the
 * files), "Let Toki's AI do it" (QuickAdd) and "Add a link" (the full form with its address field),
 * for a game that is online elsewhere already.
 */
export function AddStart({ onPick }: { onPick: (c: AddStartChoice) => void }) {
  const { t } = useI18n();
  // Without the AI, the quick way still fills in what simple checks of the files find.
  const ai = useAiFeature("describe");
  const cards: { id: AddStartChoice; title: string; text: string }[] = [
    { id: "manual", title: t("start.manual"), text: t("start.manualText") },
    { id: "ai", title: ai ? t("start.ai") : t("start.quick"), text: ai ? t("start.aiText") : t("start.quickText") },
    { id: "link", title: t("start.link"), text: t("start.linkText") },
  ];
  return (
    <section className="panel add-start">
      <h1 className="h">{t("form.addTitle")}</h1>
      <p className="lead">{t("start.lead")}</p>
      <div className="start-cards">
        {cards.map((c) => (
          <button key={c.id} type="button" className="start-card" onClick={() => onPick(c.id)}>
            <b>{c.title}</b>
            <span>{c.text}</span>
          </button>
        ))}
      </div>
      <p className="sub">
        {t("start.docsLead")} <Link to="/docs">{t("start.docs")}</Link>
      </p>
    </section>
  );
}
