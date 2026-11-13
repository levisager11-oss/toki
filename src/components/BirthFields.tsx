import { useI18n } from "../lib/i18n";

/** "When were you born?": a month and a year. Toki never asks for the day. */
export function BirthFields({ month, year, onMonth, onYear, idPrefix = "born" }: {
  month: string; year: string; onMonth: (m: string) => void; onYear: (y: string) => void; idPrefix?: string;
}) {
  const { t, lang } = useI18n();
  const thisYear = new Date().getFullYear();
  const monthName = new Intl.DateTimeFormat(lang === "de" ? "de-CH" : "en", { month: "long" });
  return (
    <fieldset className="birth-fields">
      <legend>{t("age.question")}</legend>
      <div className="inline-form">
        <select id={`${idPrefix}-month`} required value={month} onChange={(e) => onMonth(e.target.value)} aria-label={t("age.month")} autoComplete="bday-month">
          <option value="">{t("age.month")}</option>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{monthName.format(new Date(2000, i, 1))}</option>)}
        </select>
        <select id={`${idPrefix}-year`} required value={year} onChange={(e) => onYear(e.target.value)} aria-label={t("age.year")} autoComplete="bday-year">
          <option value="">{t("age.year")}</option>
          {Array.from({ length: 100 }, (_, i) => <option key={i} value={thisYear - i}>{thisYear - i}</option>)}
        </select>
      </div>
      <small>{t("age.why")}</small>
    </fieldset>
  );
}
