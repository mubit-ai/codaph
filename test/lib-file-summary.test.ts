import { describe, expect, it } from "vitest";
import { summarizeFileForOffload } from "../src/lib/file-summary";

const TS = `// auth.ts — handles login
// second comment line
import { db } from "./db";

export interface User { id: string; name: string; }
export type Role = "admin" | "user";
export const MAX_ATTEMPTS = 3;

export async function login(name: string, pw: string): Promise<User> {
  if (pw.length === 0) throw new Error("empty");
  return db.find(name);
}

export class AuthService {
  private cache = new Map();
  async authenticate(token: string): Promise<boolean> {
    if (!token) return false;
    return true;
  }
  logout(id: string): void {
    this.cache.delete(id);
  }
}
`;

describe("summarizeFileForOffload", () => {
  it("captures the doc comment, exported signatures, constants, and method outline", () => {
    const s = summarizeFileForOffload("src/auth.ts", TS, 400);
    expect(s).toContain("src/auth.ts");
    expect(s).toContain("lines");
    expect(s).toContain("handles login"); // leading doc comment
    expect(s).toContain("export interface User");
    expect(s).toContain("export type Role");
    expect(s).toContain("export const MAX_ATTEMPTS = 3"); // constant VALUE preserved
    expect(s).toContain("export async function login");
    expect(s).toContain("export class AuthService");
    // method signatures (indented) are captured…
    expect(s).toContain("authenticate");
    expect(s).toContain("logout");
    // …but control-flow lines inside bodies are NOT mistaken for declarations.
    expect(s).not.toContain("throw new Error");
    expect(s).not.toContain("return db.find");
  });

  it("is much smaller than the source and clamps to the token budget", () => {
    const big = TS.repeat(50);
    const s = summarizeFileForOffload("src/big.ts", big, 100);
    expect(s.length).toBeLessThanOrEqual(100 * 4 + 40); // budget chars + marker slack
    expect(s.length).toBeLessThan(big.length);
  });

  it("falls back to a head preview for non-code files", () => {
    const md = "# Title\n\nSome intro paragraph.\n\n- bullet one\n- bullet two\n";
    const s = summarizeFileForOffload("README.md", md, 400);
    expect(s).toContain("README.md");
    expect(s).toContain("Preview:");
    expect(s).toContain("# Title");
  });

  it("returns a header even for empty input", () => {
    const s = summarizeFileForOffload("empty.ts", "", 400);
    expect(s).toContain("empty.ts");
  });
});
