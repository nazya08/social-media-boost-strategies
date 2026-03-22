import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppConfig } from "../config.js";
import { DataStore, Donor, Language, Post, PostStatus, RunLog } from "./store.js";

type SupabaseRow = Record<string, any>;

const coerceLanguage = (value: unknown): Language => (String(value ?? "UA").trim().toUpperCase() === "EN" ? "EN" : "UA");

const toIso = (v: any) => {
  const s = String(v ?? "").trim();
  return s || undefined;
};

const normalizeAccountKey = (raw: string) => raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

export class SupabaseStore implements DataStore {
  private readonly client: SupabaseClient;
  private readonly tables: { donors: string; posts: string; runLogs: string };

  constructor(private readonly config: AppConfig) {
    if (!config.supabase?.url || !config.supabase?.serviceRoleKey) {
      throw new Error("SupabaseStore: missing supabase config");
    }
    this.client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const rawPrefix = String(config.supabase.tablePrefix ?? "").trim();
    const prefix = rawPrefix ? (rawPrefix.endsWith("_") ? rawPrefix : `${rawPrefix}_`) : "";
    const withPrefix = (name: string) => {
      const base = String(name ?? "").trim();
      if (!prefix) return base;
      if (base.startsWith(prefix)) return base;
      return `${prefix}${base}`;
    };

    this.tables = {
      donors: withPrefix(config.supabase.donorsTableName ?? "threads_donors"),
      posts: withPrefix(config.supabase.postsTableName ?? "posts"),
      runLogs: withPrefix(config.supabase.runLogsTableName ?? "run_logs")
    };
  }

  private applyAccountScope<T extends { or: (filters: string) => T }>(
    query: T,
    params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }
  ) {
    const keyRaw = String(params.accountKey ?? "").trim();
    if (!keyRaw) return query;
    const key = normalizeAccountKey(keyRaw);
    if (params.treatBlankAccountKeyAsMatch) {
      return query.or(`account_key.eq.${key},account_key.is.null,account_key.eq.,account_key.eq.DEFAULT`);
    }
    return query.or(`account_key.eq.${key}`);
  }

  async listActiveDonors(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Donor[]> {
    let q = this.client
      .from(this.tables.donors)
      .select("id,username,feed_url,language,skip_media,notes,status")
      .eq("status", "Active")
      .neq("feed_url", "")
      .limit(params.maxRecords);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase listActiveDonors failed: ${error.message}`);
    return (data ?? []).map((r: SupabaseRow) => ({
      id: String(r.id),
      username: String(r.username ?? "").trim() || String(r.id),
      feedUrl: String(r.feed_url ?? "").trim(),
      language: coerceLanguage(r.language),
      skipMedia: r.skip_media === true,
      notes: String(r.notes ?? "").trim() || undefined
    }));
  }

  async touchDonorFetchedAt(params: { donorId: string; fetchedAtIso: string }): Promise<void> {
    const { error } = await this.client
      .from(this.tables.donors)
      .update({ last_fetched_at: params.fetchedAtIso })
      .eq("id", params.donorId);
    if (error) throw new Error(`Supabase touchDonorFetchedAt failed: ${error.message}`);
  }

  async updateDonor(params: { donorId: string; status?: "Active" | "Inactive"; notes?: string }): Promise<void> {
    const patch: Record<string, any> = {};
    if (params.status) patch.status = params.status;
    if (params.notes !== undefined) patch.notes = params.notes;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client.from(this.tables.donors).update(patch).eq("id", params.donorId);
    if (error) throw new Error(`Supabase updateDonor failed: ${error.message}`);
  }

  async hasPostBySeedUrl(params: { seedUrl: string; accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    let q = this.client.from(this.tables.posts).select("id").eq("seed_url", params.seedUrl).limit(1);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase hasPostBySeedUrl failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async hasPostBySeedHash(params: { seedHash: string; accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    let q = this.client.from(this.tables.posts).select("id").eq("seed_hash", params.seedHash).limit(1);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase hasPostBySeedHash failed: ${error.message}`);
    return (data ?? []).length > 0;
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
    const row: Record<string, any> = {
      title: params.title,
      seed_text: params.seedText,
      seed_url: params.seedUrl ?? null,
      seed_published_at: params.seedPublishedAtIso ?? null,
      seed_author: params.seedAuthor ?? null,
      seed_hash: params.seedHash,
      post_status: "Seeded",
      language: params.language,
      cta_text: params.ctaText,
      cta_url: params.ctaUrl,
      source_id: params.sourceId ?? null,
      media_url: params.mediaUrl ?? null,
      media_type: params.mediaType ?? null,
      media_alt_text: params.mediaAltText ?? null,
      account_key: params.accountKey ? normalizeAccountKey(params.accountKey) : null
    };
    const { data, error } = await this.client.from(this.tables.posts).insert(row).select("id").single();
    if (error) throw new Error(`Supabase createSeedPost failed: ${error.message}`);
    return { postId: String((data as any)?.id) };
  }

  private mapPost(row: SupabaseRow): Post {
    const parts = row.thread_parts_json;
    const threadParts = Array.isArray(parts) ? parts.map((p: any) => String(p)) : null;
    return {
      id: String(row.id),
      title: String(row.title ?? "Seed"),
      seedText: String(row.seed_text ?? ""),
      seedUrl: toIso(row.seed_url),
      language: coerceLanguage(row.language),
      postStatus: (String(row.post_status ?? "").trim() || undefined) as any,
      ctaText: String(row.cta_text ?? "") || undefined,
      ctaUrl: String(row.cta_url ?? "") || undefined,
      format: String(row.format ?? "") || undefined,
      threadParts,
      threadPreview: String(row.thread_preview ?? "") || undefined,
      attributionUrl: String(row.attribution_url ?? "") || undefined,
      threadsRootId: String(row.threads_root_id ?? "") || undefined,
      threadsRootUrl: String(row.threads_root_url ?? "") || undefined,
      scheduledAt: toIso(row.scheduled_at),
      publishedAt: toIso(row.published_at),
      attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : Number(row.attempt_count ?? 0),
      lastAttemptAt: toIso(row.last_attempt_at),
      error: String(row.error ?? "") || undefined,
      failureSubsystem: (String(row.failure_subsystem ?? "") || undefined) as any,
      mediaUrl: String(row.media_url ?? "") || undefined,
      mediaType: String(row.media_type ?? "") || undefined,
      mediaAltText: String(row.media_alt_text ?? "") || undefined,
      seedPublishedAt: toIso(row.seed_published_at),
      seedAuthor: String(row.seed_author ?? "") || undefined,
      seedHash: String(row.seed_hash ?? "") || undefined,
      sourceId: String(row.source_id ?? "") || undefined,
      accountKey: String(row.account_key ?? "") || undefined
    };
  }

  async listPostsForGenerate(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number; recordIds?: string[] }): Promise<Post[]> {
    let q = this.client
      .from(this.tables.posts)
      .select(
        "id,title,seed_text,seed_url,language,cta_text,cta_url,thread_parts_json,post_status,failure_subsystem,seed_published_at,seed_author,seed_hash,format,thread_preview,attribution_url,threads_root_id,threads_root_url,scheduled_at,published_at,attempt_count,last_attempt_at,error,media_url,media_type,media_alt_text,account_key"
      )
      .order("seed_published_at", { ascending: false })
      .limit(params.maxRecords);
    q = this.applyAccountScope(q as any, params) as any;
    if (params.recordIds && params.recordIds.length > 0) {
      q = (q as any).in("id", params.recordIds);
    }
    // broad filter in DB, strict in JS (match Airtable logic)
    q = (q as any).in("post_status", ["Seeded", "Failed"]).is("thread_parts_json", null);
    const { data, error } = await q;
    if (error) throw new Error(`Supabase listPostsForGenerate failed: ${error.message}`);
    const rows = (data ?? []) as SupabaseRow[];
    const filtered = rows.filter((r) => {
      const status = String(r.post_status ?? "");
      const failureSubsystem = String(r.failure_subsystem ?? "");
      if (status === "Seeded") return true;
      if (status === "Failed" && failureSubsystem === "GENERATE") return true;
      return false;
    });
    return filtered.map((r) => this.mapPost(r));
  }

  async markPostGenerated(params: { postId: string; format: string; language: Language; threadParts: string[]; threadPreview: string; ctaText: string; ctaUrl: string }): Promise<void> {
    const { error } = await this.client
      .from(this.tables.posts)
      .update({
        post_status: "Generated",
        format: params.format,
        language: params.language,
        thread_parts_json: params.threadParts,
        thread_preview: params.threadPreview,
        cta_text: params.ctaText,
        cta_url: params.ctaUrl,
        error: null,
        failure_subsystem: null
      })
      .eq("id", params.postId);
    if (error) throw new Error(`Supabase markPostGenerated failed: ${error.message}`);
  }

  async markPostFailed(params: { postId: string; subsystem: "GENERATE" | "PUBLISH"; errorMessage: string }): Promise<void> {
    const { error } = await this.client
      .from(this.tables.posts)
      .update({ post_status: "Failed", error: params.errorMessage, failure_subsystem: params.subsystem })
      .eq("id", params.postId);
    if (error) throw new Error(`Supabase markPostFailed failed: ${error.message}`);
  }

  async listStuckPublishing(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Array<Pick<Post, "id" | "lastAttemptAt" | "attemptCount" | "error" | "threadsRootId">>> {
    let q = this.client
      .from(this.tables.posts)
      .select("id,last_attempt_at,attempt_count,error,threads_root_id,post_status")
      .eq("post_status", "Publishing")
      .not("last_attempt_at", "is", null)
      .limit(params.maxRecords);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase listStuckPublishing failed: ${error.message}`);
    return (data ?? []).map((r: SupabaseRow) => ({
      id: String(r.id),
      lastAttemptAt: toIso(r.last_attempt_at),
      attemptCount: typeof r.attempt_count === "number" ? r.attempt_count : Number(r.attempt_count ?? 0),
      error: String(r.error ?? "") || undefined,
      threadsRootId: String(r.threads_root_id ?? "") || undefined
    }));
  }

  async listPublishablePosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number; recordIds?: string[] }): Promise<Array<Post>> {
    let q = this.client
      .from(this.tables.posts)
      .select(
        "id,title,seed_text,seed_url,language,cta_text,cta_url,format,thread_parts_json,thread_preview,attribution_url,threads_root_id,threads_root_url,attempt_count,last_attempt_at,error,failure_subsystem,media_url,media_type,media_alt_text,post_status,account_key"
      )
      .in("post_status", ["Publishing", "Generated", "Failed"])
      .order("seed_published_at", { ascending: false })
      .limit(params.maxRecords);
    q = this.applyAccountScope(q as any, params) as any;
    if (params.recordIds && params.recordIds.length > 0) {
      q = (q as any).in("id", params.recordIds);
    }
    const { data, error } = await q;
    if (error) throw new Error(`Supabase listPublishablePosts failed: ${error.message}`);
    const posts = (data ?? []).map((r: SupabaseRow) => this.mapPost(r));

    const publishable = posts.filter((p) => {
      const status = String(p.postStatus ?? "");
      const errorText = String(p.error ?? "");
      const rootId = String(p.threadsRootId ?? "");
      const attempts = Number(p.attemptCount ?? 0);
      const failureSubsystem = String(p.failureSubsystem ?? "");
      if (status === "Publishing") {
        return (errorText && errorText.startsWith("PROGRESS:")) || Boolean(rootId);
      }
      if (status === "Generated") return true;
      if (status === "Failed") {
        if (failureSubsystem !== "PUBLISH") return false;
        if (attempts >= 3) return false;
        if (/HTTP 401|HTTP 403/i.test(errorText)) return false;
        return true;
      }
      return false;
    });

    return publishable.slice(0, params.maxRecords);
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
    const patch: Record<string, any> = { post_status: params.postStatus };
    if (params.error !== undefined) patch.error = params.error || null;
    if (params.lastAttemptAtIso) patch.last_attempt_at = params.lastAttemptAtIso;
    if (params.attemptCount !== undefined) patch.attempt_count = params.attemptCount;
    if (params.failureSubsystem !== undefined) patch.failure_subsystem = params.failureSubsystem;
    if (params.threadsRootId) patch.threads_root_id = params.threadsRootId;
    const { error } = await this.client.from(this.tables.posts).update(patch).eq("id", params.postId);
    if (error) throw new Error(`Supabase updatePostForPublishAttempt failed: ${error.message}`);
  }

  async markPostPublished(params: { postId: string; publishedAtIso: string; threadsRootId: string; threadsRootUrl: string }): Promise<void> {
    const { error } = await this.client
      .from(this.tables.posts)
      .update({
        post_status: "Published",
        published_at: params.publishedAtIso,
        threads_root_id: params.threadsRootId,
        threads_root_url: params.threadsRootUrl,
        failure_subsystem: null,
        error: null
      })
      .eq("id", params.postId);
    if (error) throw new Error(`Supabase markPostPublished failed: ${error.message}`);
  }

  async listScheduledPosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean; maxRecords: number }): Promise<Array<Pick<Post, "id" | "scheduledAt" | "seedUrl">>> {
    let q = this.client
      .from(this.tables.posts)
      .select("id,scheduled_at,seed_url,post_status")
      .eq("post_status", "Scheduled")
      .not("scheduled_at", "is", null)
      .limit(params.maxRecords);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase listScheduledPosts failed: ${error.message}`);
    return (data ?? []).map((r: SupabaseRow) => ({ id: String(r.id), scheduledAt: toIso(r.scheduled_at), seedUrl: toIso(r.seed_url) }));
  }

  async hasQueuePosts(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<boolean> {
    let q = this.client.from(this.tables.posts).select("id").in("post_status", ["Generated", "Scheduled"]).limit(1);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase hasQueuePosts failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async getLastPublishedAt(params: { accountKey?: string; treatBlankAccountKeyAsMatch?: boolean }): Promise<string | undefined> {
    let q = this.client
      .from(this.tables.posts)
      .select("published_at")
      .eq("post_status", "Published")
      .order("published_at", { ascending: false })
      .limit(1);
    q = this.applyAccountScope(q as any, params) as any;
    const { data, error } = await q;
    if (error) throw new Error(`Supabase getLastPublishedAt failed: ${error.message}`);
    return toIso((data ?? [])[0]?.published_at);
  }

  async createRunLog(log: RunLog): Promise<void> {
    const { error } = await this.client.from(this.tables.runLogs).insert({
      timestamp: log.timestampIso,
      level: log.level,
      subsystem: log.subsystem,
      post_id: log.postId ?? null,
      message: log.message,
      error_stack: log.errorStack ?? null,
      meta_json: log.metaJson ?? null
    });
    if (error) throw new Error(`Supabase createRunLog failed: ${error.message}`);
  }

  async cleanupRunLogs(params: { thresholdRecords: number; trimToRecords: number }): Promise<void> {
    // Best-effort; use SQL for cleanup. Keep no-op in JS store.
    void params;
  }
}
