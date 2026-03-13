import { clamp } from "../utils/text.js";

export type ThreadsClientOptions = {
  accessToken: string;
  userId: string;
  deviceId?: string;
  apiBaseUrl: string;
  replyRetryCount?: number;
  replyRetryDelayMs?: number;
  interPartDelayMs?: number;
};

export type ThreadsPublishLogEvent = {
  level: "INFO" | "WARN";
  stage: "ROOT_CREATE" | "ROOT_PUBLISH" | "REPLY_WAIT" | "REPLY_CREATE" | "REPLY_PUBLISH";
  partIndex?: number;
  attempt?: number;
  message: string;
  meta?: unknown;
};

export type ThreadsPublishOverrides = {
  replyRetryCount?: number;
  replyRetryDelayMs?: number;
  interPartDelayMs?: number;
};

export type ThreadsPartPublishedEvent = {
  partIndex: number;
  publishedId: string;
};

export type PublishResult = {
  rootId: string;
  rootPermalink?: string;
  allIds: string[];
};

export type RootMedia =
  | { type: "IMAGE"; url: string; altText?: string }
  | { type: "VIDEO"; url: string; altText?: string };

export class ThreadsClient {
  constructor(private readonly options: ThreadsClientOptions) {}

  private async sleep(ms: number) {
    if (ms <= 0) return;
    await new Promise((r) => setTimeout(r, ms));
  }

  private isPropagationNotReadyError(error: unknown) {
    if (!(error instanceof Error)) return false;
    // Graph sometimes returns this subcode when the replied-to post isn't visible yet.
    return (
      error.message.includes("\"error_subcode\":4279009") ||
      error.message.includes("error_subcode\":4279009") ||
      error.message.includes("The requested resource does not exist")
    );
  }

  private async publishCreationIdWithRetry(
    creationId: string,
    emit?: (event: ThreadsPublishLogEvent) => Promise<void> | void,
    ctx?: { partIndex?: number; isRoot?: boolean; overrides?: ThreadsPublishOverrides }
  ) {
    const retryCount = ctx?.overrides?.replyRetryCount ?? this.options.replyRetryCount ?? 3;
    const retryDelayMs = ctx?.overrides?.replyRetryDelayMs ?? this.options.replyRetryDelayMs ?? 30_000;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        await emit?.({
          level: "INFO",
          stage: ctx?.isRoot ? "ROOT_PUBLISH" : "REPLY_PUBLISH",
          partIndex: ctx?.partIndex,
          attempt,
          message: "Publishing creation_id",
          meta: { creationId }
        });
        const publish = await this.postForm(`/${this.options.userId}/threads_publish`, { creation_id: creationId });
        const publishedId = String(publish?.id ?? "");
        if (!publishedId) throw new Error(`Threads publish returned no id: ${JSON.stringify(publish)}`);
        await emit?.({
          level: "INFO",
          stage: ctx?.isRoot ? "ROOT_PUBLISH" : "REPLY_PUBLISH",
          partIndex: ctx?.partIndex,
          attempt,
          message: "Published ok",
          meta: { publishedId }
        });
        return publishedId;
      } catch (err) {
        lastErr = err;
        if (this.isPropagationNotReadyError(err) && attempt < retryCount) {
          await emit?.({
            level: "WARN",
            stage: ctx?.isRoot ? "ROOT_PUBLISH" : "REPLY_PUBLISH",
            partIndex: ctx?.partIndex,
            attempt,
            message: "Publish not ready yet; sleeping before retry",
            meta: { retryDelayMs }
          });
          await this.sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }

    throw lastErr ?? new Error("Threads publish failed");
  }

  private async postForm(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(path, this.options.apiBaseUrl);
    const body = new URLSearchParams({
      ...params,
      access_token: this.options.accessToken,
      ...(this.options.deviceId ? { device_id: this.options.deviceId } : {})
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Threads HTTP ${res.status}: ${text}`);
    return text ? (JSON.parse(text) as any) : {};
  }

  private async getJson(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(path, this.options.apiBaseUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set("access_token", this.options.accessToken);

    const res = await fetch(url, {
      method: "GET",
      headers: {}
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Threads HTTP ${res.status}: ${text}`);
    return text ? (JSON.parse(text) as any) : {};
  }

  async getPermalink(postId: string): Promise<string | undefined> {
    try {
      const details = await this.getJson(`/${postId}`, { fields: "permalink" });
      if (typeof details?.permalink === "string") return details.permalink;
    } catch {
      // best-effort
    }
    return undefined;
  }

  async publishThread(
    parts: string[],
    maxCharsPerPart: number,
    rootMedia?: RootMedia,
    opts?: {
      log?: (event: ThreadsPublishLogEvent) => Promise<void> | void;
      onPartPublished?: (event: ThreadsPartPublishedEvent) => Promise<void> | void;
      overrides?: ThreadsPublishOverrides;
    }
  ): Promise<PublishResult> {
    if (parts.length < 2) throw new Error("Thread must have at least 2 parts (root + CTA).");
    const sanitized = parts.map((p) => clamp(String(p ?? ""), maxCharsPerPart).trim()).filter(Boolean);
    if (sanitized.length < 2) throw new Error("Thread parts are empty after sanitization.");

    const allIds: string[] = [];
    const emit = opts?.log ? async (e: ThreadsPublishLogEvent) => await opts.log?.(e) : undefined;
    const overrides = opts?.overrides;

    const rootParams: Record<string, string> = {
      media_type: rootMedia?.type ?? "TEXT",
      text: sanitized[0]
    };
    if (rootMedia?.type === "IMAGE") {
      rootParams.image_url = rootMedia.url;
      if (rootMedia.altText) rootParams.alt_text = rootMedia.altText;
    }
    if (rootMedia?.type === "VIDEO") {
      rootParams.video_url = rootMedia.url;
      if (rootMedia.altText) rootParams.alt_text = rootMedia.altText;
    }

    await emit?.({
      level: "INFO",
      stage: "ROOT_CREATE",
      partIndex: 0,
      message: "Creating root container",
      meta: { mediaType: rootParams.media_type }
    });
    const rootCreation = await this.postForm(`/${this.options.userId}/threads`, rootParams);
    const rootCreationId = String(rootCreation?.id ?? "");
    if (!rootCreationId) throw new Error(`Threads create container returned no id: ${JSON.stringify(rootCreation)}`);

    await emit?.({
      level: "INFO",
      stage: "ROOT_CREATE",
      partIndex: 0,
      message: "Root container created",
      meta: { creationId: rootCreationId }
    });

    const rootId = await this.publishCreationIdWithRetry(rootCreationId, emit, { isRoot: true, partIndex: 0, overrides });
    allIds.push(rootId);
    await opts?.onPartPublished?.({ partIndex: 0, publishedId: rootId });

    let replyToId = rootId;
    const interPartDelayMs = overrides?.interPartDelayMs ?? this.options.interPartDelayMs ?? 30_000;
    for (let i = 1; i < sanitized.length; i++) {
      let publishedId: string | undefined;
      let lastErr: unknown;

      const retryCount = overrides?.replyRetryCount ?? this.options.replyRetryCount ?? 3;
      const retryDelayMs = overrides?.replyRetryDelayMs ?? this.options.replyRetryDelayMs ?? 30_000;

      // Always wait before trying to create/publish a reply (matches desired behavior).
      await emit?.({
        level: "INFO",
        stage: "REPLY_WAIT",
        partIndex: i,
        message: "Waiting before reply publish attempt 1",
        meta: { ms: interPartDelayMs }
      });
      await this.sleep(interPartDelayMs);

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          await emit?.({
            level: "INFO",
            stage: "REPLY_CREATE",
            partIndex: i,
            attempt,
            message: "Creating reply container",
            meta: { replyToId }
          });
          const creation = await this.postForm(`/${this.options.userId}/threads`, {
            media_type: "TEXT",
            text: sanitized[i],
            reply_to_id: replyToId
          });
          const creationId = String(creation?.id ?? "");
          if (!creationId) throw new Error(`Threads create reply container returned no id: ${JSON.stringify(creation)}`);

          await emit?.({
            level: "INFO",
            stage: "REPLY_CREATE",
            partIndex: i,
            attempt,
            message: "Reply container created",
            meta: { creationId }
          });

          publishedId = await this.publishCreationIdWithRetry(creationId, emit, { partIndex: i, isRoot: false, overrides });
          break;
        } catch (err) {
          lastErr = err;
          if (this.isPropagationNotReadyError(err) && attempt < retryCount) {
            await emit?.({
              level: "WARN",
              stage: "REPLY_PUBLISH",
              partIndex: i,
              attempt,
              message: "Reply not ready yet; sleeping before retry",
              meta: { retryDelayMs }
            });
            await this.sleep(retryDelayMs);
            continue;
          }
          throw err;
        }
      }

      if (!publishedId) throw lastErr ?? new Error("Failed to publish reply");

      allIds.push(publishedId);
      replyToId = publishedId;
      await opts?.onPartPublished?.({ partIndex: i, publishedId });
    }

    const permalink = await this.getPermalink(rootId);

    return { rootId, rootPermalink: permalink, allIds };
  }

  async publishReplies(params: {
    replyToId: string;
    parts: string[];
    startIndex: number;
    maxCharsPerPart: number;
    opts?: {
      log?: (event: ThreadsPublishLogEvent) => Promise<void> | void;
      onPartPublished?: (event: ThreadsPartPublishedEvent) => Promise<void> | void;
      overrides?: ThreadsPublishOverrides;
    };
  }): Promise<{ allIds: string[] }> {
    const sanitized = params.parts.map((p) => clamp(String(p ?? ""), params.maxCharsPerPart).trim()).filter(Boolean);
    if (sanitized.length < 2) throw new Error("Thread parts are empty after sanitization.");
    const start = Math.max(1, Math.min(params.startIndex, sanitized.length));
    if (start >= sanitized.length) return { allIds: [] };

    const emit = params.opts?.log ? async (e: ThreadsPublishLogEvent) => await params.opts?.log?.(e) : undefined;
    const allIds: string[] = [];

    let replyToId = params.replyToId;
    const overrides = params.opts?.overrides;
    const interPartDelayMs = overrides?.interPartDelayMs ?? this.options.interPartDelayMs ?? 30_000;
    const retryCount = overrides?.replyRetryCount ?? this.options.replyRetryCount ?? 3;
    const retryDelayMs = overrides?.replyRetryDelayMs ?? this.options.replyRetryDelayMs ?? 30_000;

    for (let i = start; i < sanitized.length; i++) {
      let publishedId: string | undefined;
      let lastErr: unknown;

      await emit?.({
        level: "INFO",
        stage: "REPLY_WAIT",
        partIndex: i,
        message: `Waiting before reply publish attempt 1 (resume)`,
        meta: { ms: interPartDelayMs, replyToId }
      });
      await this.sleep(interPartDelayMs);

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          await emit?.({
            level: "INFO",
            stage: "REPLY_CREATE",
            partIndex: i,
            attempt,
            message: "Creating reply container (resume)",
            meta: { replyToId }
          });
          const creation = await this.postForm(`/${this.options.userId}/threads`, {
            media_type: "TEXT",
            text: sanitized[i],
            reply_to_id: replyToId
          });
          const creationId = String(creation?.id ?? "");
          if (!creationId) throw new Error(`Threads create reply container returned no id: ${JSON.stringify(creation)}`);

          await emit?.({
            level: "INFO",
            stage: "REPLY_CREATE",
            partIndex: i,
            attempt,
            message: "Reply container created (resume)",
            meta: { creationId }
          });

          publishedId = await this.publishCreationIdWithRetry(creationId, emit, { partIndex: i, isRoot: false, overrides });
          break;
        } catch (err) {
          lastErr = err;
          if (this.isPropagationNotReadyError(err) && attempt < retryCount) {
            await emit?.({
              level: "WARN",
              stage: "REPLY_PUBLISH",
              partIndex: i,
              attempt,
              message: "Reply not ready yet; sleeping before retry (resume)",
              meta: { retryDelayMs }
            });
            await this.sleep(retryDelayMs);
            continue;
          }
          throw err;
        }
      }

      if (!publishedId) throw lastErr ?? new Error("Failed to publish reply (resume)");
      allIds.push(publishedId);
      replyToId = publishedId;
      await params.opts?.onPartPublished?.({ partIndex: i, publishedId });
    }

    return { allIds };
  }
}
