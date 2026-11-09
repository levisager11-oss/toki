// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";

beforeEach(() => {
  (globalThis as { document?: unknown }).document = { title: "" };
});

describe("tab title", () => {
  it("shows the page and the unread count", async () => {
    const { titleFor } = await import("../src/lib/useTitle");
    expect(titleFor(null, 0)).toBe("Toki");
    expect(titleFor("Chat", 0)).toBe("Chat · Toki");
    expect(titleFor("Chat", 3)).toBe("(3) Chat · Toki");
    expect(titleFor(null, 150)).toBe("(99+) Toki");
  });
});
