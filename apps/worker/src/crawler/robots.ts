export interface RobotsRules {
  disallowed: string[];
  allowed: string[];
  sitemaps: string[];
}

interface Group {
  agents: string[];
  disallowed: string[];
  allowed: string[];
}

export const NO_ROBOTS: RobotsRules = { disallowed: [], allowed: [], sitemaps: [] };

/**
 * Parses robots.txt for one crawler. The group naming our product token wins
 * over `*`; consecutive User-agent lines share the rules that follow them.
 * Sitemap lines apply regardless of group.
 */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const { groups, sitemaps } = readDirectives(body);
  const group = pickGroup(groups, userAgent.split("/")[0]!.trim().toLowerCase());
  return {
    disallowed: group?.disallowed ?? [],
    allowed: group?.allowed ?? [],
    sitemaps,
  };
}

function readDirectives(body: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const { key, value } of directives(body)) {
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], disallowed: [], allowed: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && value) {
      if (key === "disallow") current.disallowed.push(value);
      if (key === "allow") current.allowed.push(value);
    }
    lastWasAgent = key === "user-agent";
  }
  return { groups, sitemaps };
}

function* directives(body: string): Generator<{ key: string; value: string }> {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    yield { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
  }
}

function pickGroup(groups: Group[], token: string): Group | undefined {
  return (
    groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a))) ??
    groups.find((g) => g.agents.includes("*"))
  );
}

/** The longest matching rule wins; Allow wins a tie. */
export function robotsAllows(pathname: string, rules: RobotsRules): boolean {
  const longest = (paths: string[]) =>
    Math.max(-1, ...paths.filter((p) => pathname.startsWith(p)).map((p) => p.length));
  return longest(rules.allowed) >= longest(rules.disallowed);
}
