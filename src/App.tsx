import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { Layout } from "./components/Layout";
import { RequireMember } from "./components/RequireMember";
import { Home } from "./pages/Home";
import { Favorites } from "./pages/Favorites";
import { GamePage } from "./pages/GamePage";
import { NotFound } from "./pages/NotFound";

// Pages most visitors don't open load on demand, so players download less.
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Signup = lazy(() => import("./pages/Signup").then((m) => ({ default: m.Signup })));
const MyGames = lazy(() => import("./pages/MyGames").then((m) => ({ default: m.MyGames })));
const GameForm = lazy(() => import("./pages/GameForm").then((m) => ({ default: m.GameForm })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));
const FeedbackBoard = lazy(() => import("./pages/FeedbackBoard").then((m) => ({ default: m.FeedbackBoard })));
const FeedbackPost = lazy(() => import("./pages/FeedbackPost").then((m) => ({ default: m.FeedbackPost })));
const FeedbackInbox = lazy(() => import("./pages/FeedbackInbox").then((m) => ({ default: m.FeedbackInbox })));
const Releases = lazy(() => import("./pages/Releases").then((m) => ({ default: m.Releases })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Friends = lazy(() => import("./pages/Friends").then((m) => ({ default: m.Friends })));
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Reports = lazy(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));
const Apply = lazy(() => import("./pages/Apply").then((m) => ({ default: m.Apply })));
const Applications = lazy(() => import("./pages/Applications").then((m) => ({ default: m.Applications })));
const Invites = lazy(() => import("./pages/Invites").then((m) => ({ default: m.Invites })));

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
          <Route path="invites" element={<RequireMember admin><Later><Invites /></Later></RequireMember>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Analytics />
    </>
  );
}
