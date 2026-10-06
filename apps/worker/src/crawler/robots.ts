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
/** RFC 9309: a robots.txt that cannot be fetched (5xx) means assume everything is disallowed. */
export const DISALLOW_ALL: RobotsRules = { disallowed: ["/"], allowed: [], sitemaps: [] };

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

/**
 * The longest matching rule wins, measured by its raw length; Allow wins a tie.
 * `pathAndQuery` is the URL's pathname plus search, which is what rules match.
 */
export function robotsAllows(pathAndQuery: string, rules: RobotsRules): boolean {
  const longest = (patterns: string[]) =>
    Math.max(-1, ...patterns.filter((p) => ruleMatches(p, pathAndQuery)).map((p) => p.length));
  return longest(rules.allowed) >= longest(rules.disallowed);
}

/** RFC 9309 pattern: `*` matches any run of characters, a trailing `$` anchors the end. */
function ruleMatches(rule: string, target: string): boolean {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  // An unanchored rule matches any URL it is a prefix of, i.e. it ends in an implicit `*`.
  return globMatches(anchored ? body : `${body}*`, target);
}

/**
 * Whole-string glob match on `*` only. Written as the two-pointer walk rather
 * than a regex because robots.txt is written by the target, and stacked
 * wildcards must not be able to backtrack catastrophically.
 */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
