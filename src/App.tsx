import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireMember } from "./components/RequireMember";
import { Home } from "./pages/Home";
import { Favorites } from "./pages/Favorites";
import { GamePage } from "./pages/GamePage";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { MyGames } from "./pages/MyGames";
import { GameForm } from "./pages/GameForm";
import { Invites } from "./pages/Invites";
import { NotFound } from "./pages/NotFound";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="game/:slug" element={<GamePage />} />
        <Route path="login" element={<Login />} />
        <Route path="signup" element={<Signup />} />
        <Route path="my-games" element={<RequireMember><MyGames /></RequireMember>} />
        <Route path="add" element={<RequireMember><GameForm key="add" /></RequireMember>} />
        <Route path="edit/:slug" element={<RequireMember><GameForm /></RequireMember>} />
        <Route path="invites" element={<RequireMember admin><Invites /></RequireMember>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
