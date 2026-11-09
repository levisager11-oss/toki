import { describe, expect, it } from "vitest";
import { passwordError } from "../src/components/PasswordForm";

describe("passwordError", () => {
  it("explains why a new password wasn't saved", () => {
    expect(passwordError("New password should be different from the old password.")).toBe("pw.same");
    expect(passwordError("Password should be at least 8 characters.")).toBe("signup.passwordHelp");
    expect(passwordError("Password is known to be weak and easy to guess")).toBe("signup.passwordHelp");
    expect(passwordError("For security purposes, you can only request this after 60 seconds. Rate limit")).toBe("login.resetWait");
    expect(passwordError("Something else")).toBe("error");
  });
});
