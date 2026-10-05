export interface OSVVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{
    type: string;
    score: string;
  }>;
}

export class OSVClient {
  private baseUrl: string;

  constructor(baseUrl = "https://api.osv.dev/v1/query") {
    this.baseUrl = baseUrl;
  }

  async queryPackage(packageName: string, version: string, ecosystem = "npm"): Promise<OSVVulnerability[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package: { name: packageName, ecosystem },
          version,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return [];
      }

      const data: any = await response.json();
      return data.vulns || [];
    } catch (err) {
      console.warn(`[OSVClient] Query failed for ${packageName}@${version}:`, err);
      return [];
    }
  }
}
