export type WorkspaceId = "chat" | "files" | "video" | "voice" | "watch" | "collaborate" | "canvas";

/** Second pane of a split layout; only chat + collaboration/canvas pairs exist. */
export type SplitSideWorkspace = "chat" | "collaborate" | "canvas";

const WORKSPACE_IDS: readonly WorkspaceId[] = ["chat", "files", "video", "voice", "watch", "collaborate", "canvas"];
const SPLIT_PARTNERS: readonly SplitSideWorkspace[] = ["chat", "collaborate", "canvas"];

export type WorkspaceHash = {
  active: WorkspaceId | null;
  side: SplitSideWorkspace | null;
};

function isWorkspaceId(value: string): value is WorkspaceId {
  return (WORKSPACE_IDS as readonly string[]).includes(value);
}

function isSplitPartner(value: string): value is SplitSideWorkspace {
  return (SPLIT_PARTNERS as readonly string[]).includes(value);
}

/** A side pane is valid only for {chat, collaborate} or {chat, canvas} pairs. */
function splitPairValid(active: WorkspaceId | null, side: SplitSideWorkspace | null): boolean {
  if (active === null || side === null) return false;
  if (active === side) return false;
  const pair = new Set([active, side]);
  return pair.has("chat") && (pair.has("collaborate") || pair.has("canvas"));
}

/**
 * Parses `#workspace` and `#workspace+side` hashes. `#status` keeps its
 * historical special case (rewrites to `#chat`, returns chat). Invalid side
 * tokens or illegal pairs degrade to the single-workspace form so old links
 * and typos never break navigation.
 */
export function parseWorkspaceHash(hash: string): WorkspaceHash {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const tokens = raw.split("+");
  const active = isWorkspaceId(tokens[0]) ? tokens[0] : null;
  // A side pane exists only for a well-formed two-token hash; empty segments
  // ("#chat+") and extras ("#chat+canvas+extra") keep the active workspace and
  // drop the side.
  const sideToken = tokens.length === 2 ? tokens[1] : "";
  const side = isSplitPartner(sideToken) ? sideToken : null;
  return { active, side: splitPairValid(active, side) ? side : null };
}

export function formatWorkspaceHash(active: WorkspaceId | null, side: SplitSideWorkspace | null): string {
  if (!splitPairValid(active, side)) return `#${active ?? ""}`;
  return `#${active}+${side}`;
}
