import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Profile } from "./types";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ session: null, profile: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
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
    await supabase.auth.signOut();
  };

  return <AuthContext.Provider value={{ session, profile, loading, signOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
