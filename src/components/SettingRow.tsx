import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** A group of settings rows under a heading, like a phone's settings. */
export function SettingGroup({ title, children, id }: { title?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="set-group" aria-labelledby={title && id ? `${id}-h` : undefined}>
      {title && <h2 id={id ? `${id}-h` : undefined}>{title}</h2>}
      <div className="set-list">{children}</div>
    </section>
  );
}

/**
 * One row: a title and one line of explanation on the left, its control (a switch, a small
 * button) on the right. `below`: something that takes the whole width under it (a text field,
 * a form that opened).
 */
export function SettingRow({ title, help, children, below, danger, htmlFor }: {
  title: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
  danger?: boolean;
  htmlFor?: string;
}) {
  return (
    <div className={`set-row${danger ? " danger" : ""}`}>
      <div className="set-main">
        <div className="set-text">
          {htmlFor ? <label htmlFor={htmlFor} className="set-title">{title}</label> : <span className="set-title">{title}</span>}
          {help && <small>{help}</small>}
        </div>
        {children && <div className="set-ctl">{children}</div>}
      </div>
      {below && <div className="set-below">{below}</div>}
    </div>
  );
}

/** A row that leads to another page: the whole row is the link, with an arrow. */
export function LinkRow({ to, title, help, extra }: { to: string; title: ReactNode; help?: ReactNode; extra?: ReactNode }) {
  return (
    <Link to={to} className="set-row set-link">
      <div className="set-main">
        <div className="set-text">
          <span className="set-title">{title}</span>
          {help && <small>{help}</small>}
        </div>
        <div className="set-ctl">
          {extra}
          <span className="set-arrow" aria-hidden="true">›</span>
        </div>
      </div>
    </Link>
  );
}

/** An on/off switch (a checkbox that looks like one). */
export function Switch({ id, checked, disabled, onChange, label }: { id?: string; checked: boolean; disabled?: boolean; onChange: () => void; label?: string }) {
  return (
    <span className="switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
      <span aria-hidden="true" />
    </span>
  );
}
