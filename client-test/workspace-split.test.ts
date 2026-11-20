import { describe, expect, it } from "vitest";

import { formatWorkspaceHash, parseWorkspaceHash, type WorkspaceId } from "../src/shared/workspace-hash";

const ALL_WORKSPACES: WorkspaceId[] = ["chat", "files", "video", "voice", "watch", "collaborate", "canvas"];

describe("parseWorkspaceHash", () => {
  it("parses every single-workspace hash exactly as before", () => {
    for (const id of ALL_WORKSPACES) expect(parseWorkspaceHash(`#${id}`)).toEqual({ active: id, side: null });
  });

  it("treats legacy unknown/empty hashes as the ready screen", () => {
    expect(parseWorkspaceHash("")).toEqual({ active: null, side: null });
    expect(parseWorkspaceHash("#")).toEqual({ active: null, side: null });
    expect(parseWorkspaceHash("#unknown")).toEqual({ active: null, side: null });
    expect(parseWorkspaceHash("#chatx")).toEqual({ active: null, side: null });
  });

  it("parses both orderings of valid split pairs", () => {
    expect(parseWorkspaceHash("#chat+canvas")).toEqual({ active: "chat", side: "canvas" });
    expect(parseWorkspaceHash("#canvas+chat")).toEqual({ active: "canvas", side: "chat" });
    expect(parseWorkspaceHash("#chat+collaborate")).toEqual({ active: "chat", side: "collaborate" });
    expect(parseWorkspaceHash("#collaborate+chat")).toEqual({ active: "collaborate", side: "chat" });
  });

  it("drops illegal side tokens and pairs, keeping the active workspace", () => {
    expect(parseWorkspaceHash("#files+canvas")).toEqual({ active: "files", side: null });
    expect(parseWorkspaceHash("#video+chat")).toEqual({ active: "video", side: null });
    expect(parseWorkspaceHash("#chat+chat")).toEqual({ active: "chat", side: null });
    expect(parseWorkspaceHash("#canvas+collaborate")).toEqual({ active: "canvas", side: null });
    expect(parseWorkspaceHash("#collaborate+collaborate")).toEqual({ active: "collaborate", side: null });
    expect(parseWorkspaceHash("#chat+files")).toEqual({ active: "chat", side: null });
    expect(parseWorkspaceHash("#chat+bogus")).toEqual({ active: "chat", side: null });
    expect(parseWorkspaceHash("#chat+")).toEqual({ active: "chat", side: null });
    expect(parseWorkspaceHash("#chat+canvas+extra")).toEqual({ active: "chat", side: null });
    expect(parseWorkspaceHash("#status")).toEqual({ active: null, side: null });
  });

  it("accepts hashes without the leading hash sign for robustness", () => {
    expect(parseWorkspaceHash("chat+canvas")).toEqual({ active: "chat", side: "canvas" });
  });
});

describe("formatWorkspaceHash", () => {
  it("reproduces the legacy single-workspace hash byte for byte", () => {
    for (const id of ALL_WORKSPACES) expect(formatWorkspaceHash(id, null)).toBe(`#${id}`);
    expect(formatWorkspaceHash(null, null)).toBe("#");
  });

  it("formats both orderings of valid pairs and refuses illegal ones", () => {
    expect(formatWorkspaceHash("chat", "canvas")).toBe("#chat+canvas");
    expect(formatWorkspaceHash("canvas", "chat")).toBe("#canvas+chat");
    expect(formatWorkspaceHash("files", "canvas")).toBe("#files");
    expect(formatWorkspaceHash("chat", "chat")).toBe("#chat");
    expect(formatWorkspaceHash("canvas", "collaborate")).toBe("#canvas");
  });

  it("round-trips through parse for every valid combination", () => {
    const partners = ["chat", "collaborate", "canvas"] as const;
    for (const active of ALL_WORKSPACES) {
      for (const side of partners) {
        const hash = formatWorkspaceHash(active, side);
        expect(parseWorkspaceHash(hash)).toEqual({ active, side: hash.includes("+") ? side : null });
      }
    }
  });
});
