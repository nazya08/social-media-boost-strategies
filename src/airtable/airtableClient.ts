export type AirtableRecord<TFields extends Record<string, unknown>> = {
  id: string;
  createdTime?: string;
  fields: TFields;
};

export type AirtableListResponse<TFields extends Record<string, unknown>> = {
  records: Array<AirtableRecord<TFields>>;
  offset?: string;
};

type AirtableClientOptions = {
  apiKey: string;
  baseId: string;
};

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms));

const encodeQuery = (params: Record<string, string | undefined>) => {
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.set(key, value);
  }
  return url.toString();
};

export class AirtableClient {
  private readonly apiKey: string;
  private readonly baseId: string;

  constructor(options: AirtableClientOptions) {
    this.apiKey = options.apiKey;
    this.baseId = options.baseId;
  }

  private urlForTable(tableName: string, query?: Record<string, string | undefined>) {
    const encodedTable = encodeURIComponent(tableName);
    const baseUrl = `${AIRTABLE_API_BASE}/${this.baseId}/${encodedTable}`;
    if (!query) return baseUrl;
    const qs = encodeQuery(query);
    return qs ? `${baseUrl}?${qs}` : baseUrl;
  }

  private async request<T>(input: RequestInfo | URL, init: RequestInit & { retries?: number } = {}): Promise<T> {
    const retries = init.retries ?? 3;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined)
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(input, { ...init, headers });
        const text = await res.text();
        const data = text ? (JSON.parse(text) as unknown) : ({} as unknown);

        if (!res.ok) {
          const error = new Error(`Airtable HTTP ${res.status}: ${text}`);
          (error as any).status = res.status;
          throw error;
        }

        return data as T;
      } catch (err) {
        lastError = err;
        // Airtable transient errors / network
        const backoffMs = Math.min(10_000, 500 * attempt * attempt);
        await sleep(backoffMs);
      }
    }
    throw lastError;
  }

  async listAll<TFields extends Record<string, unknown>>(
    tableName: string,
    options?: {
      filterByFormula?: string;
      sortField?: string;
      sortDirection?: "asc" | "desc";
      maxRecords?: number;
      fields?: string[];
      pageSize?: number;
    }
  ): Promise<Array<AirtableRecord<TFields>>> {
    const all: Array<AirtableRecord<TFields>> = [];
    let offset: string | undefined;

    while (true) {
      const query: Record<string, string | undefined> = {
        filterByFormula: options?.filterByFormula,
        maxRecords: options?.maxRecords ? String(options.maxRecords) : undefined,
        pageSize: options?.pageSize ? String(options.pageSize) : "100",
        offset
      };

      if (options?.sortField) {
        query["sort[0][field]"] = options.sortField;
        query["sort[0][direction]"] = options.sortDirection ?? "asc";
      }
      if (options?.fields && options.fields.length > 0) {
        options.fields.forEach((field, idx) => {
          query[`fields[${idx}]`] = field;
        });
      }

      const url = this.urlForTable(tableName, query);
      const page = await this.request<AirtableListResponse<TFields>>(url, { method: "GET" });
      all.push(...page.records);
      if (!page.offset) break;
      offset = page.offset;
      if (options?.maxRecords && all.length >= options.maxRecords) {
        return all.slice(0, options.maxRecords);
      }
    }

    return all;
  }

  async createRecord<TFields extends Record<string, unknown>>(
    tableName: string,
    fields: TFields
  ): Promise<AirtableRecord<TFields>> {
    const url = this.urlForTable(tableName);
    return await this.request<AirtableRecord<TFields>>(url, {
      method: "POST",
      body: JSON.stringify({ fields })
    });
  }

  async updateRecord<TFields extends Record<string, unknown>>(
    tableName: string,
    recordId: string,
    fields: Partial<TFields>
  ): Promise<AirtableRecord<TFields>> {
    const url = `${this.urlForTable(tableName)}/${recordId}`;
    return await this.request<AirtableRecord<TFields>>(url, {
      method: "PATCH",
      body: JSON.stringify({ fields })
    });
  }
}

