export interface EPSSResult {
  cve: string;
  epss: number;
  percentile: number;
  date?: string;
}

export class EPSSClient {
  private baseUrl: string;

  constructor(baseUrl = "https://api.first.org/data/v1/epss") {
    this.baseUrl = baseUrl;
  }

  async getScore(cveId: string): Promise<EPSSResult | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const url = `${this.baseUrl}?cve=${encodeURIComponent(cveId)}`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data: any = await response.json();
      if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
        const item = data.data[0];
        return {
          cve: item.cve,
          epss: parseFloat(item.epss),
          percentile: parseFloat(item.percentile),
          date: item.date,
        };
      }

      return null;
    } catch (err) {
      console.warn(`[EPSSClient] Query failed for ${cveId}:`, err);
      return null;
    }
  }
}
