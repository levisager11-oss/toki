// Public Supabase settings for server code (the same public values the website uses in .env).
// `process` may not exist in Vercel's edge runtime, so read it carefully.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
export const SUPABASE_URL = env.VITE_SUPABASE_URL || "https://oygszctxhkubofspywzr.supabase.co";
export const SUPABASE_KEY = env.VITE_SUPABASE_KEY || "sb_publishable_KFAa4b76LmSpFO-C2M5ymA_CnCQLcBR";
