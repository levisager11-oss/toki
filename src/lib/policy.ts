// The privacy policy follows Toki's settings: which AI services get players' text right now, and
// when that last changed (supabase/migrations/20261202090000_policy_facts.sql). The deletion
// times in the policy follow the admin's settings too ({keep.…}, see limitValues.ts).
import { supabase } from "./supabase";

export interface PolicyFacts {
  /** Host names of the AI services in use; empty while AI is switched off. */
  ai_hosts: string[];
  /** When the AI services last changed, if ever. */
  changed_at: string | null;
}

/** The day the texts in src/lib/texts/legal*.ts were last changed. Change it with them. */
export const LEGAL_DATE = "2026-11-13";

/**
 * AI services by the host an admin enters on the AI page, as the policy names them: the company
 * and its country. A service that isn't listed is named by its host; add it here to name it properly.
 */
const AI_SERVICES: Record<string, string> = {
  "api.anthropic.com": "Anthropic (Anthropic PBC, USA)",
  "api.openai.com": "OpenAI (OpenAI OpCo, LLC, USA)",
  "generativelanguage.googleapis.com": "Google (Google LLC, USA)",
  "openrouter.ai": "OpenRouter (OpenRouter, Inc., USA)",
  "api.mistral.ai": "Mistral AI (Mistral AI SAS, France)",
  "api.groq.com": "Groq (Groq, Inc., USA)",
};

export const ANTHROPIC_HOST = "api.anthropic.com";

/** The name of the service at a host, or null when Toki doesn't know it. */
export const aiServiceName = (host: string): string | null => AI_SERVICES[host] ?? null;

/** The later of the texts' date and the settings' date, as "YYYY-MM-DD". */
export function policyDate(facts: PolicyFacts | null, textDate = LEGAL_DATE): string {
  const changed = facts?.changed_at?.slice(0, 10) ?? "";
  return changed > textDate ? changed : textDate;
}

/** null when it can't be loaded: the policy then names no service, instead of claiming AI is off. */
export async function loadPolicyFacts(): Promise<PolicyFacts | null> {
  const { data, error } = await supabase.rpc("policy_facts");
  if (error || !data) return null;
  const d = data as Partial<PolicyFacts>;
  return { ai_hosts: Array.isArray(d.ai_hosts) ? d.ai_hosts : [], changed_at: d.changed_at ?? null };
}
