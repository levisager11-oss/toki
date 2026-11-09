import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useNavigate } from "react-router-dom";
import { supabase } from "./supabase";
import { stopAccountSaves } from "./saves";
import { syncAccountLikes } from "./local";
import { useBadgeUpdates } from "./useBadges";
import type { Profile } from "./types";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** true once it is known whether someone is logged in on this device. */
  ready: boolean;
  signOut: () => Promise<void>;
  /** Loads the profile again, e.g. after changing the avatar. */
  reloadProfile: () => void;
}

const AuthContext = createContext<AuthState>({ session: null, profile: null, loading: true, ready: false, signOut: async () => {}, reloadProfile: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [profileRun, setProfileRun] = useState(0);
  const loadedFor = useRef<string | undefined>(undefined);
  // Kept in a ref: navigate changes with every page, and the login listener should only start once.
  const nav = useNavigate();
  const navigate = useRef(nav);
  navigate.current = nav;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      if (!s) stopAccountSaves(); // logged out (also in another tab)
      setSession(s);
      // Opened the link from a "reset your password" email (wherever it led): choose the new password.
      if (e === "PASSWORD_RECOVERY" && location.pathname !== "/reset-password") navigate.current("/reset-password", { replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (ready) syncAccountLikes(userId ?? null);
  }, [ready, userId]);
  useBadgeUpdates(userId);

  useEffect(() => {
    if (!userId) {
      loadedFor.current = undefined;
      setProfile(null);
      return;
    }
    let alive = true;
    // Reloading the same account's profile keeps the page as it is (no "loading" in between).
    if (loadedFor.current !== userId) setLoading(true);
    loadedFor.current = userId;
    supabase
      .from("profiles")
      .select("id, username, role, bio, avatar_url, avatar_seed")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        setProfile((data as Profile) ?? null);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId, profileRun]);

  const signOut = async () => {
    stopAccountSaves(); // nothing goes up to the account on the way out
    await supabase.auth.signOut();
  };

  return <AuthContext.Provider value={{ session, profile, loading, ready, signOut, reloadProfile: () => setProfileRun((n) => n + 1) }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
