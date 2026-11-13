import { describe, expect, it } from "vitest";
import { aiServiceName, policyDate } from "../src/lib/policy";

describe("the privacy policy's facts", () => {
  it("name known AI services with their company and country", () => {
    expect(aiServiceName("api.anthropic.com")).toBe("Anthropic (Anthropic PBC, USA)");
    expect(aiServiceName("ai.example.com")).toBeNull();
  });

  it("show the later of the texts' date and the settings' date", () => {
    expect(policyDate(null, "2026-11-13")).toBe("2026-11-13");
    expect(policyDate({ ai_hosts: [], games_hosted: false, changed_at: null }, "2026-11-13")).toBe("2026-11-13");
    expect(policyDate({ ai_hosts: [], games_hosted: true, changed_at: "2026-10-01T08:00:00+00:00" }, "2026-11-13")).toBe("2026-11-13");
    expect(policyDate({ ai_hosts: ["api.anthropic.com"], games_hosted: true, changed_at: "2026-12-02T08:00:00+00:00" }, "2026-11-13")).toBe("2026-12-02");
  });
});
