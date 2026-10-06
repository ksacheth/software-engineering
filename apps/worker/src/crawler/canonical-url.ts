const DROP = new Set([
  "sid",
  "session",
  "sessionid",
  "phpsessid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
]);

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";

  for (const key of [...u.searchParams.keys()]) {
    if (DROP.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }

  // Parameter order carries no meaning, so reordered URLs are one page. The
  // trailing slash does: /dir and /dir/ are different resources.
  u.searchParams.sort();

  return u.toString();
}