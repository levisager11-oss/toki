import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { loadTexts, useI18n, type TextGroup } from "./lib/i18n";
import { Route, Routes } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { Layout } from "./components/Layout";
import { RequireMember } from "./components/RequireMember";
import { Home } from "./pages/Home";
import { Favorites } from "./pages/Favorites";
import { GamePage } from "./pages/GamePage";
import { NotFound } from "./pages/NotFound";
import { loadPage } from "./lib/reload";

/**
 * A page that loads on demand, together with the groups of texts it uses (src/lib/texts/), at
 * the same time. tests/texts.test.ts says if a page needs a group it doesn't name.
 */
function page<P extends { default: ComponentType<any> }>(load: () => Promise<P>, ...texts: TextGroup[]) {
  return lazy(loadPage(() => Promise.all([load(), loadTexts(texts)]).then(([m]) => m)));
}

// Pages most visitors don't open load on demand, so players download less.
const Login = page(() => import("./pages/Login").then((m) => ({ default: m.Login })), "player");
const Signup = page(() => import("./pages/Signup").then((m) => ({ default: m.Signup })), "player");
const GameStats = page(() => import("./pages/GameStats").then((m) => ({ default: m.GameStats })), "player", "dev");
const MyGames = page(() => import("./pages/MyGames").then((m) => ({ default: m.MyGames })), "player", "dev");
const GameForm = page(() => import("./pages/GameForm").then((m) => ({ default: m.GameForm })), "player", "dev");
const Account = page(() => import("./pages/Account").then((m) => ({ default: m.Account })), "player");
const FeedbackBoard = page(() => import("./pages/FeedbackBoard").then((m) => ({ default: m.FeedbackBoard })), "player");
const FeedbackPost = page(() => import("./pages/FeedbackPost").then((m) => ({ default: m.FeedbackPost })), "player");
const FeedbackInbox = page(() => import("./pages/FeedbackInbox").then((m) => ({ default: m.FeedbackInbox })), "player", "dev");
const Releases = page(() => import("./pages/Releases").then((m) => ({ default: m.Releases })), "player");
const Profile = page(() => import("./pages/Profile").then((m) => ({ default: m.Profile })), "player");
const Friends = page(() => import("./pages/Friends").then((m) => ({ default: m.Friends })), "player");
const Chat = page(() => import("./pages/Chat").then((m) => ({ default: m.Chat })), "player");
const Notifications = page(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })), "player");
const Reports = page(() => import("./pages/Reports").then((m) => ({ default: m.Reports })), "player", "dev");
const Apply = page(() => import("./pages/Apply").then((m) => ({ default: m.Apply })), "player");
const Applications = page(() => import("./pages/Applications").then((m) => ({ default: m.Applications })), "player", "dev");
const Admin = page(() => import("./pages/Admin").then((m) => ({ default: m.Admin })), "player", "dev");
const AiAdmin = page(() => import("./pages/AiAdmin").then((m) => ({ default: m.AiAdmin })), "player", "dev");
const HostingAdmin = page(() => import("./pages/HostingAdmin").then((m) => ({ default: m.HostingAdmin })), "player", "dev");
const LimitsAdmin = page(() => import("./pages/LimitsAdmin").then((m) => ({ default: m.LimitsAdmin })), "player", "dev");
const Connect = page(() => import("./pages/Connect").then((m) => ({ default: m.Connect })), "player", "dev");
const ConnectJob = page(() => import("./pages/ConnectJob").then((m) => ({ default: m.ConnectJob })), "player", "dev");
const ConnectGitHub = page(() => import("./pages/ConnectGitHub").then((m) => ({ default: m.ConnectGitHub })), "player", "dev");
const ResetPassword = page(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })), "player");
const Ideas = page(() => import("./pages/Ideas").then((m) => ({ default: m.Ideas })), "player");
const Idea = page(() => import("./pages/Idea").then((m) => ({ default: m.Idea })), "player");
const Invites = page(() => import("./pages/Invites").then((m) => ({ default: m.Invites })), "player", "dev");
const Legal = page(() => import("./pages/Legal").then((m) => ({ default: m.Legal })), "legal");

/** Shown while a page's code is still downloading (slow connections); after a short wait, so fast loads don't flash. */
function PageLoading() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  return (
    <section className="panel narrow skel" style={{ minHeight: "60vh" }} aria-busy="true" aria-label={t("loading")}>
      <span className="bar big" />
      <span className="bar" style={{ width: "80%" }} />
      <span className="bar" style={{ width: "55%" }} />
    </section>
  );
}

const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={<PageLoading />}>{children}</Suspense>;

export function App() {
  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="favorites" element={<Favorites />} />
          <Route path="game/:slug" element={<GamePage />} />
          <Route path="game/:slug/feedback" element={<Later><FeedbackBoard /></Later>} />
          <Route path="game/:slug/stats" element={<RequireMember><Later><GameStats /></Later></RequireMember>} />
          <Route path="game/:slug/updates" element={<Later><Releases /></Later>} />
          <Route path="updates" element={<Later><Releases /></Later>} />
          <Route path="feedback" element={<Later><FeedbackBoard /></Later>} />
          <Route path="feedback/inbox" element={<RequireMember><Later><FeedbackInbox /></Later></RequireMember>} />
          <Route path="feedback/:id" element={<Later><FeedbackPost /></Later>} />
          <Route path="terms" element={<Later><Legal page="terms" /></Later>} />
          <Route path="privacy" element={<Later><Legal page="privacy" /></Later>} />
          <Route path="login" element={<Later><Login /></Later>} />
          <Route path="signup" element={<Later><Signup /></Later>} />
          <Route path="reset-password" element={<Later><ResetPassword /></Later>} />
          <Route path="my-games" element={<RequireMember><Later><MyGames /></Later></RequireMember>} />
          <Route path="add" element={<RequireMember><Later><GameForm key="add" /></Later></RequireMember>} />
          <Route path="edit/:slug" element={<RequireMember><Later><GameForm /></Later></RequireMember>} />
          <Route path="account" element={<RequireMember player><Later><Account /></Later></RequireMember>} />
          <Route path="u/:username" element={<Later><Profile /></Later>} />
          <Route path="friends" element={<RequireMember player><Later><Friends /></Later></RequireMember>} />
          <Route path="chat" element={<RequireMember player><Later><Chat /></Later></RequireMember>} />
          <Route path="chat/:id" element={<RequireMember player><Later><Chat /></Later></RequireMember>} />
          <Route path="notifications" element={<RequireMember player><Later><Notifications /></Later></RequireMember>} />
          <Route path="ideas" element={<RequireMember player><Later><Ideas /></Later></RequireMember>} />
          <Route path="ideas/:id" element={<RequireMember player><Later><Idea /></Later></RequireMember>} />
          <Route path="reports" element={<RequireMember admin><Later><Reports /></Later></RequireMember>} />
          <Route path="apply" element={<RequireMember player><Later><Apply /></Later></RequireMember>} />
          <Route path="applications" element={<RequireMember admin><Later><Applications /></Later></RequireMember>} />
          <Route path="admin" element={<RequireMember admin><Later><Admin /></Later></RequireMember>} />
          <Route path="admin/ai" element={<RequireMember admin><Later><AiAdmin /></Later></RequireMember>} />
          <Route path="admin/hosting" element={<RequireMember admin><Later><HostingAdmin /></Later></RequireMember>} />
          <Route path="admin/limits" element={<RequireMember admin><Later><LimitsAdmin /></Later></RequireMember>} />
          <Route path="connect" element={<RequireMember><Later><Connect /></Later></RequireMember>} />
          <Route path="connect/github" element={<RequireMember><Later><ConnectGitHub /></Later></RequireMember>} />
          <Route path="connect/:id" element={<RequireMember><Later><ConnectJob /></Later></RequireMember>} />
          <Route path="invites" element={<RequireMember admin><Later><Invites /></Later></RequireMember>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Analytics />
    </>
  );
}
