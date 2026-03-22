import { AirtableClient } from "../airtable/airtableClient.js";
import { DonorFields, PostFields, RunLogFields, Tables } from "../airtable/fields.js";
import { accountKeyFilterFormula, escapeAirtableString } from "../utils/airtableFormula.js";
import { DataStore, Donor, Language, Post, PostStatus, RunLog } from "./store.js";

type AirtableDonorFields = Record<string, unknown>;
type AirtablePostFields = Record<string, unknown>;

const coerceLanguage = (value: unknown): Language => (String(value ?? "UA").trim().toUpperCase() === "EN" ? "EN" : "UA");

const coerceBool = (value: unknown) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return undefined;
};

export class AirtableStore implements DataStore {
  constructor(
    private readonly airtable: AirtableClient,
    private readonly tableNames: { posts: string; donors: string; runLogs: string } = {
      posts: Tables.POSTS,
      donors: Tables.DONORS,
      runLogs: Tables.RUN_LOGS
    }
  ) {}

  async listActiveDonors(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Donor[]> {
    const donorsBaseFilter = `AND({${DonorFields.Status}}="Active", {${DonorFields.FeedUrl}}!="")`;
    const accountFilter =
      params.accountKey && params.accountKey.trim()
        ? accountKeyFilterFormula({
            fieldName: DonorFields.AccountKey,
            accountKey: params.accountKey.trim(),
            treatBlankAsAccount: params.treatBlankAccountKeyAsMatch
          })
        : undefined;

    const filterByFormula = accountFilter ? `AND(${donorsBaseFilter}, ${accountFilter})` : donorsBaseFilter;
    const records = await this.airtable.listAll<AirtableDonorFields>(this.tableNames.donors, {
      filterByFormula,
      maxRecords: params.maxRecords
    });

    return records
      .map((r) => {
        const username = String(r.fields?.[DonorFields.Username] ?? "").trim() || r.id;
        const feedUrl = String(r.fields?.[DonorFields.FeedUrl] ?? "").trim();
        return {
          id: r.id,
          username,
          feedUrl,
          language: coerceLanguage(r.fields?.[DonorFields.Language]),
          skipMedia: coerceBool(r.fields?.[DonorFields.SkipMedia]),
          notes: String(r.fields?.[DonorFields.Notes] ?? "").trim() || undefined
        } satisfies Donor;
      })
      .filter((d) => d.feedUrl);
  }

  async touchDonorFetchedAt(params: { donorId: string; fetchedAtIso: string }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.donors, params.donorId, {
      [DonorFields.LastFetchedAt]: params.fetchedAtIso
    } as any);
  }

  async updateDonor(params: { donorId: string; status?: "Active" | "Inactive"; notes?: string }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.donors, params.donorId, {
      ...(params.status ? { [DonorFields.Status]: params.status } : {}),
      ...(params.notes !== undefined ? { [DonorFields.Notes]: params.notes } : {})
    } as any);
  }

  private accountFilter(fieldName: string, accountKey?: string, treatBlank?: boolean) {
    if (!accountKey || !accountKey.trim()) return undefined;
    return accountKeyFilterFormula({ fieldName, accountKey: accountKey.trim(), treatBlankAsAccount: treatBlank });
  }

  async hasPostBySeedUrl(params: { seedUrl: string; accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    const urlFilter = `{${PostFields.SeedUrl}}="${escapeAirtableString(params.seedUrl)}"`;
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const filterByFormula = accountFilter ? `AND(${urlFilter}, ${accountFilter})` : urlFilter;
    const existing = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, { filterByFormula, maxRecords: 1 });
    return existing.length > 0;
  }

  async hasPostBySeedHash(params: { seedHash: string; accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    const hashFilter = `{${PostFields.SeedHash}}="${escapeAirtableString(params.seedHash)}"`;
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const filterByFormula = accountFilter ? `AND(${hashFilter}, ${accountFilter})` : hashFilter;
    const existing = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, { filterByFormula, maxRecords: 1 });
    return existing.length > 0;
  }

  async createSeedPost(params: {
    title: string;
    seedText: string;
    seedUrl?: string;
    seedPublishedAtIso?: string;
    seedAuthor?: string;
    seedHash: string;
    language: Language;
    ctaText: string;
    ctaUrl: string;
    sourceId?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaAltText?: string;
    accountKey?: string;
  }): Promise<{ postId: string }> {
    const fields: Record<string, unknown> = {
      [PostFields.Title]: params.title,
      [PostFields.SeedText]: params.seedText,
      [PostFields.SeedUrl]: params.seedUrl || undefined,
      [PostFields.SeedPublishedAt]: params.seedPublishedAtIso || undefined,
      [PostFields.SeedAuthor]: params.seedAuthor || undefined,
      [PostFields.SeedHash]: params.seedHash,
      ...(params.accountKey ? { [PostFields.AccountKey]: params.accountKey } : {}),
      [PostFields.PostStatus]: "Seeded",
      [PostFields.Language]: params.language,
      [PostFields.CtaText]: params.ctaText,
      [PostFields.CtaUrl]: params.ctaUrl,
      ...(params.sourceId ? { [PostFields.Source]: [params.sourceId] } : {}),
      ...(params.mediaUrl ? { [PostFields.MediaUrl]: params.mediaUrl } : {}),
      ...(params.mediaType ? { [PostFields.MediaType]: params.mediaType } : {}),
      ...(params.mediaAltText ? { [PostFields.MediaAltText]: params.mediaAltText } : {})
    };

    const created = await this.airtable.createRecord(this.tableNames.posts, fields as any);
    return { postId: created.id };
  }

  private mapPost(r: { id: string; fields: AirtablePostFields }): Post {
    const threadPartsJson = String(r.fields?.[PostFields.ThreadPartsJson] ?? "").trim();
    let threadParts: string[] | null = null;
    if (threadPartsJson) {
      try {
        const parsed = JSON.parse(threadPartsJson);
        if (Array.isArray(parsed)) threadParts = parsed.map((p) => String(p));
      } catch {
        // ignore
      }
    }

    return {
      id: r.id,
      title: String(r.fields?.[PostFields.Title] ?? "Seed"),
      seedText: String(r.fields?.[PostFields.SeedText] ?? ""),
      seedUrl: String(r.fields?.[PostFields.SeedUrl] ?? "") || undefined,
      language: coerceLanguage(r.fields?.[PostFields.Language]),
      postStatus: (String(r.fields?.[PostFields.PostStatus] ?? "").trim() || undefined) as any,
      ctaText: String(r.fields?.[PostFields.CtaText] ?? "") || undefined,
      ctaUrl: String(r.fields?.[PostFields.CtaUrl] ?? "") || undefined,
      format: String(r.fields?.[PostFields.Format] ?? "") || undefined,
      threadParts,
      threadPreview: String(r.fields?.[PostFields.ThreadPreview] ?? "") || undefined,
      attributionUrl: String(r.fields?.[PostFields.AttributionUrl] ?? "") || undefined,
      threadsRootId: String(r.fields?.[PostFields.ThreadsRootId] ?? "") || undefined,
      threadsRootUrl: String(r.fields?.[PostFields.ThreadsRootUrl] ?? "") || undefined,
      scheduledAt: String(r.fields?.[PostFields.ScheduledAt] ?? "") || undefined,
      publishedAt: String(r.fields?.[PostFields.PublishedAt] ?? "") || undefined,
      attemptCount: Number(r.fields?.[PostFields.AttemptCount] ?? 0),
      lastAttemptAt: String(r.fields?.[PostFields.LastAttemptAt] ?? "") || undefined,
      error: String(r.fields?.[PostFields.Error] ?? "") || undefined,
      failureSubsystem: (String(r.fields?.[PostFields.FailureSubsystem] ?? "") || undefined) as any,
      mediaUrl: String(r.fields?.[PostFields.MediaUrl] ?? "") || undefined,
      mediaType: String(r.fields?.[PostFields.MediaType] ?? "") || undefined,
      mediaAltText: String(r.fields?.[PostFields.MediaAltText] ?? "") || undefined,
      seedPublishedAt: String(r.fields?.[PostFields.SeedPublishedAt] ?? "") || undefined,
      seedAuthor: String(r.fields?.[PostFields.SeedAuthor] ?? "") || undefined,
      seedHash: String(r.fields?.[PostFields.SeedHash] ?? "") || undefined,
      accountKey: String(r.fields?.[PostFields.AccountKey] ?? "") || undefined
    };
  }

  async listPostsForGenerate(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number; recordIds?: string[] }): Promise<Post[]> {
    const baseFilter = `AND(OR({${PostFields.PostStatus}}="Seeded", AND({${PostFields.PostStatus}}="Failed", {${PostFields.FailureSubsystem}}="GENERATE")), OR({${PostFields.ThreadPartsJson}}="", {${PostFields.ThreadPartsJson}}=BLANK()))`;
    const idsFilter =
      params.recordIds && params.recordIds.length > 0
        ? `OR(${params.recordIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`
        : undefined;
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const extra = [idsFilter, accountFilter].filter(Boolean);
    const filterByFormula = extra.length > 0 ? `AND(${extra.join(", ")}, ${baseFilter})` : baseFilter;

    const records = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      maxRecords: params.recordIds?.length ? params.recordIds.length : params.maxRecords,
      sortField: PostFields.SeedPublishedAt,
      sortDirection: "desc"
    });
    return records.map((r) => this.mapPost(r));
  }

  async markPostGenerated(params: {
    postId: string;
    format: string;
    language: Language;
    threadParts: string[];
    threadPreview: string;
    ctaText: string;
    ctaUrl: string;
  }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.posts, params.postId, {
      [PostFields.PostStatus]: "Generated",
      [PostFields.Format]: params.format,
      [PostFields.Language]: params.language,
      [PostFields.ThreadPartsJson]: JSON.stringify(params.threadParts),
      [PostFields.ThreadPreview]: params.threadPreview,
      [PostFields.CtaText]: params.ctaText,
      [PostFields.CtaUrl]: params.ctaUrl,
      [PostFields.Error]: "",
      [PostFields.FailureSubsystem]: null
    } as any);
  }

  async markPostFailed(params: { postId: string; subsystem: "GENERATE" | "PUBLISH"; errorMessage: string }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.posts, params.postId, {
      [PostFields.PostStatus]: "Failed",
      [PostFields.Error]: params.errorMessage,
      [PostFields.FailureSubsystem]: params.subsystem
    } as any);
  }

  async listStuckPublishing(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Array<Pick<Post, "id" | "lastAttemptAt" | "attemptCount" | "error" | "threadsRootId">>> {
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const stuckBase = `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.LastAttemptAt}}!="")`;
    const filterByFormula = accountFilter ? `AND(${accountFilter}, ${stuckBase})` : stuckBase;
    const records = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      maxRecords: params.maxRecords,
      fields: [PostFields.LastAttemptAt, PostFields.AttemptCount, PostFields.Error, PostFields.ThreadsRootId]
    });
    return records.map((r) => ({
      id: r.id,
      lastAttemptAt: String(r.fields?.[PostFields.LastAttemptAt] ?? "") || undefined,
      attemptCount: Number(r.fields?.[PostFields.AttemptCount] ?? 0),
      error: String(r.fields?.[PostFields.Error] ?? "") || undefined,
      threadsRootId: String(r.fields?.[PostFields.ThreadsRootId] ?? "") || undefined
    }));
  }

  async listPublishablePosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number; recordIds?: string[] }): Promise<Post[]> {
    const idsFilter =
      params.recordIds && params.recordIds.length > 0
        ? `OR(${params.recordIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`
        : undefined;
    const publishingWithProgress = `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.Error}}!="", LEFT({${PostFields.Error}}, 9)="PROGRESS:")`;
    const publishingWithRootId = `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.ThreadsRootId}}!="")`;
    const basePublishable = `OR(${publishingWithProgress}, ${publishingWithRootId}, {${PostFields.PostStatus}}="Generated", AND({${PostFields.PostStatus}}="Failed", {${PostFields.FailureSubsystem}}="PUBLISH", {${PostFields.AttemptCount}}<3, NOT(REGEX_MATCH({${PostFields.Error}}, "HTTP 401|HTTP 403"))))`;
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const extra = [idsFilter, accountFilter].filter(Boolean);
    const filterByFormula = extra.length > 0 ? `AND(${extra.join(", ")}, ${basePublishable})` : basePublishable;
    const records = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      maxRecords: params.maxRecords,
      sortField: PostFields.SeedPublishedAt,
      sortDirection: "desc"
    });
    return records.map((r) => this.mapPost(r));
  }

  async updatePostForPublishAttempt(params: {
    postId: string;
    postStatus: PostStatus;
    error?: string;
    lastAttemptAtIso?: string;
    attemptCount?: number;
    failureSubsystem?: "PUBLISH" | "GENERATE" | null;
    threadsRootId?: string;
  }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.posts, params.postId, {
      [PostFields.PostStatus]: params.postStatus,
      ...(params.error !== undefined ? { [PostFields.Error]: params.error } : {}),
      ...(params.lastAttemptAtIso ? { [PostFields.LastAttemptAt]: params.lastAttemptAtIso } : {}),
      ...(params.attemptCount !== undefined ? { [PostFields.AttemptCount]: params.attemptCount } : {}),
      ...(params.failureSubsystem !== undefined ? { [PostFields.FailureSubsystem]: params.failureSubsystem } : {}),
      ...(params.threadsRootId ? { [PostFields.ThreadsRootId]: params.threadsRootId } : {})
    } as any);
  }

  async markPostPublished(params: { postId: string; publishedAtIso: string; threadsRootId: string; threadsRootUrl: string }): Promise<void> {
    await this.airtable.updateRecord(this.tableNames.posts, params.postId, {
      [PostFields.PostStatus]: "Published",
      [PostFields.PublishedAt]: params.publishedAtIso,
      [PostFields.ThreadsRootId]: params.threadsRootId,
      [PostFields.ThreadsRootUrl]: params.threadsRootUrl,
      [PostFields.FailureSubsystem]: null,
      [PostFields.Error]: ""
    } as any);
  }

  async listScheduledPosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Array<Pick<Post, "id" | "scheduledAt" | "seedUrl">>> {
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const filterByFormula = accountFilter
      ? `AND(${accountFilter}, {${PostFields.PostStatus}}="Scheduled", {${PostFields.ScheduledAt}}!="")`
      : `AND({${PostFields.PostStatus}}="Scheduled", {${PostFields.ScheduledAt}}!="")`;
    const records = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      maxRecords: params.maxRecords,
      fields: [PostFields.ScheduledAt, PostFields.SeedUrl]
    });
    return records.map((r) => ({
      id: r.id,
      scheduledAt: String(r.fields?.[PostFields.ScheduledAt] ?? "") || undefined,
      seedUrl: String(r.fields?.[PostFields.SeedUrl] ?? "") || undefined
    }));
  }

  async hasQueuePosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const filterByFormula = accountFilter
      ? `AND(${accountFilter}, OR({${PostFields.PostStatus}}="Generated", {${PostFields.PostStatus}}="Scheduled"))`
      : `OR({${PostFields.PostStatus}}="Generated", {${PostFields.PostStatus}}="Scheduled")`;
    const existing = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      maxRecords: 1,
      fields: [PostFields.PostStatus]
    });
    return existing.length > 0;
  }

  async getLastPublishedAt(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<string | undefined> {
    const accountFilter = this.accountFilter(PostFields.AccountKey, params.accountKey, params.treatBlankAccountKeyAsMatch);
    const filterByFormula = accountFilter ? `AND(${accountFilter}, {${PostFields.PostStatus}}="Published")` : `{${PostFields.PostStatus}}="Published"`;
    const lastPublished = await this.airtable.listAll<AirtablePostFields>(this.tableNames.posts, {
      filterByFormula,
      sortField: PostFields.PublishedAt,
      sortDirection: "desc",
      maxRecords: 1,
      fields: [PostFields.PublishedAt]
    });
    return String(lastPublished[0]?.fields?.[PostFields.PublishedAt] ?? "") || undefined;
  }

  async createRunLog(log: RunLog): Promise<void> {
    await this.airtable.createRecord(this.tableNames.runLogs, {
      [RunLogFields.Timestamp]: log.timestampIso,
      [RunLogFields.Level]: log.level,
      [RunLogFields.Subsystem]: log.subsystem,
      ...(log.postId ? { [RunLogFields.Post]: [log.postId] } : {}),
      [RunLogFields.Message]: log.message,
      ...(log.errorStack ? { [RunLogFields.ErrorStack]: log.errorStack } : {}),
      ...(log.metaJson ? { [RunLogFields.MetaJson]: log.metaJson } : {})
    } as any);
  }

  async cleanupRunLogs(params: { thresholdRecords: number; trimToRecords: number }): Promise<void> {
    const tableName = this.tableNames.runLogs;
    const existing = await this.airtable.listAll<Record<string, unknown>>(tableName, { maxRecords: params.thresholdRecords + 50 });
    if (existing.length <= params.thresholdRecords) return;
    const toDelete = existing.slice(0, Math.max(0, existing.length - params.trimToRecords)).map((r) => r.id);
    for (let i = 0; i < toDelete.length; i += 10) {
      await this.airtable.deleteRecords(tableName, toDelete.slice(i, i + 10));
    }
  }
}
