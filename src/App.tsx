import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { Layout } from "./components/Layout";
import { RequireMember } from "./components/RequireMember";
import { Home } from "./pages/Home";
import { Favorites } from "./pages/Favorites";
import { GamePage } from "./pages/GamePage";
import { NotFound } from "./pages/NotFound";
import { loadPage } from "./lib/reload";

// Pages most visitors don't open load on demand, so players download less.
const Login = lazy(loadPage(() => import("./pages/Login").then((m) => ({ default: m.Login }))));
const Signup = lazy(loadPage(() => import("./pages/Signup").then((m) => ({ default: m.Signup }))));
const MyGames = lazy(loadPage(() => import("./pages/MyGames").then((m) => ({ default: m.MyGames }))));
const GameForm = lazy(loadPage(() => import("./pages/GameForm").then((m) => ({ default: m.GameForm }))));
const Account = lazy(loadPage(() => import("./pages/Account").then((m) => ({ default: m.Account }))));
const FeedbackBoard = lazy(loadPage(() => import("./pages/FeedbackBoard").then((m) => ({ default: m.FeedbackBoard }))));
const FeedbackPost = lazy(loadPage(() => import("./pages/FeedbackPost").then((m) => ({ default: m.FeedbackPost }))));
const FeedbackInbox = lazy(loadPage(() => import("./pages/FeedbackInbox").then((m) => ({ default: m.FeedbackInbox }))));
const Releases = lazy(loadPage(() => import("./pages/Releases").then((m) => ({ default: m.Releases }))));
const Profile = lazy(loadPage(() => import("./pages/Profile").then((m) => ({ default: m.Profile }))));
const Friends = lazy(loadPage(() => import("./pages/Friends").then((m) => ({ default: m.Friends }))));
const Chat = lazy(loadPage(() => import("./pages/Chat").then((m) => ({ default: m.Chat }))));
const Notifications = lazy(loadPage(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications }))));
const Reports = lazy(loadPage(() => import("./pages/Reports").then((m) => ({ default: m.Reports }))));
const Apply = lazy(loadPage(() => import("./pages/Apply").then((m) => ({ default: m.Apply }))));
const Applications = lazy(loadPage(() => import("./pages/Applications").then((m) => ({ default: m.Applications }))));
const Admin = lazy(loadPage(() => import("./pages/Admin").then((m) => ({ default: m.Admin }))));
const AiAdmin = lazy(loadPage(() => import("./pages/AiAdmin").then((m) => ({ default: m.AiAdmin }))));
const Connect = lazy(loadPage(() => import("./pages/Connect").then((m) => ({ default: m.Connect }))));
const ConnectJob = lazy(loadPage(() => import("./pages/ConnectJob").then((m) => ({ default: m.ConnectJob }))));
const ConnectGitHub = lazy(loadPage(() => import("./pages/ConnectGitHub").then((m) => ({ default: m.ConnectGitHub }))));
const ResetPassword = lazy(loadPage(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword }))));
const Invites = lazy(loadPage(() => import("./pages/Invites").then((m) => ({ default: m.Invites }))));

const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;

export function App() {
  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="favorites" element={<Favorites />} />
          <Route path="game/:slug" element={<GamePage />} />
          <Route path="game/:slug/feedback" element={<Later><FeedbackBoard /></Later>} />
          <Route path="game/:slug/updates" element={<Later><Releases /></Later>} />
          <Route path="updates" element={<Later><Releases /></Later>} />
          <Route path="feedback" element={<Later><FeedbackBoard /></Later>} />
          <Route path="feedback/inbox" element={<RequireMember><Later><FeedbackInbox /></Later></RequireMember>} />
          <Route path="feedback/:id" element={<Later><FeedbackPost /></Later>} />
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
          <Route path="reports" element={<RequireMember admin><Later><Reports /></Later></RequireMember>} />
          <Route path="apply" element={<RequireMember player><Later><Apply /></Later></RequireMember>} />
          <Route path="applications" element={<RequireMember admin><Later><Applications /></Later></RequireMember>} />
          <Route path="admin" element={<RequireMember admin><Later><Admin /></Later></RequireMember>} />
          <Route path="admin/ai" element={<RequireMember admin><Later><AiAdmin /></Later></RequireMember>} />
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
