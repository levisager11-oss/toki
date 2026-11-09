import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
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
const Invites = lazy(() => import("./pages/Invites").then((m) => ({ default: m.Invites })));

const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="game/:slug" element={<GamePage />} />
        <Route path="game/:slug/feedback" element={<Later><FeedbackBoard /></Later>} />
        <Route path="feedback" element={<Later><FeedbackBoard /></Later>} />
        <Route path="feedback/inbox" element={<RequireMember><Later><FeedbackInbox /></Later></RequireMember>} />
        <Route path="feedback/:id" element={<Later><FeedbackPost /></Later>} />
        <Route path="login" element={<Later><Login /></Later>} />
        <Route path="signup" element={<Later><Signup /></Later>} />
        <Route path="my-games" element={<RequireMember><Later><MyGames /></Later></RequireMember>} />
        <Route path="add" element={<RequireMember><Later><GameForm key="add" /></Later></RequireMember>} />
        <Route path="edit/:slug" element={<RequireMember><Later><GameForm /></Later></RequireMember>} />
        <Route path="account" element={<RequireMember player><Later><Account /></Later></RequireMember>} />
        <Route path="invites" element={<RequireMember admin><Later><Invites /></Later></RequireMember>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
