import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { stopAccountSaves } from "./saves";
import type { Profile } from "./types";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** true once it is known whether someone is logged in on this device. */
  ready: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ session: null, profile: null, loading: true, ready: false, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!s) stopAccountSaves(); // logged out (also in another tab)
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    let alive = true;
    setLoading(true);
    supabase
      .from("profiles")
      .select("id, username, role")
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
  }, [userId]);

  const signOut = async () => {
    stopAccountSaves(); // nothing goes up to the account on the way out
    await supabase.auth.signOut();
  };

  return <AuthContext.Provider value={{ session, profile, loading, ready, signOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
