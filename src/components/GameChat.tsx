import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { roomId } from "../lib/social";
import type { Game } from "../lib/types";
import { ChatView } from "./ChatView";

/** The game's chat room. It only connects when opened, so visitors who just play cost nothing. */
export function GameChat({ game }: { game: Game }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  const [chatId, setChatId] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const open = () => roomId(game.id).then(setChatId, () => setErr(true));

  return (
    <section className="game-chat">
      <div className="sechead">
        <h2>{t("chat.gameRoom")}</h2>
        {chatId && <Link to={`/chat/${chatId}`} className="btn">{t("chat.openFull")}</Link>}
      </div>
      {chatId ? (
        <ChatView key={chatId} chatId={chatId} kind="game" compact />
      ) : !session ? (
        <p className="hint">{t("chat.gameRoomHelp")} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("chat.loginToChat")}</Link></p>
      ) : (
        <div className="actions">
          <button type="button" className="btn" onClick={open}>{t("chat.join")}</button>
          <span className="hint">{err ? t("error") : t("chat.gameRoomHelp")}</span>
        </div>
      )}
    </section>
  );
}
