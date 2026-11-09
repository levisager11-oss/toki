import { Component, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { isChunkError, reloadOnce } from "../lib/reload";

/** Shows a message with a reload button instead of an empty page when something breaks. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(e: unknown) {
    if (isChunkError(e)) reloadOnce();
  }

  render() {
    return this.state.failed ? <Broken /> : this.props.children;
  }
}

function Broken() {
  const { t } = useI18n();
  return (
    <div className="msg" role="alert">
      <p>{t("error")}</p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>{t("reload")}</button>
    </div>
  );
}
