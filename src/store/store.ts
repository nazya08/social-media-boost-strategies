export type Language = "UA" | "EN";

export type Donor = {
  id: string;
  username: string;
  feedUrl: string;
  language: Language;
  skipMedia?: boolean;
  notes?: string;
};

export type PostStatus = "Seeded" | "Generated" | "Publishing" | "Published" | "Scheduled" | "Failed";

export type Post = {
  id: string;
  title: string;
  seedText: string;
  seedUrl?: string;
  language: Language;
  postStatus?: PostStatus;
  ctaText?: string;
  ctaUrl?: string;
  format?: string;
  threadParts?: string[] | null;
  threadPreview?: string;
  attributionUrl?: string;
  threadsRootId?: string;
  threadsRootUrl?: string;
  scheduledAt?: string;
  publishedAt?: string;
  attemptCount?: number;
  lastAttemptAt?: string;
  error?: string;
  failureSubsystem?: string | null;
  mediaUrl?: string;
  mediaType?: string;
  mediaAltText?: string;
  seedPublishedAt?: string;
  seedAuthor?: string;
  seedHash?: string;
  sourceId?: string;
  accountKey?: string;
};

export type RunLog = {
  timestampIso: string;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  subsystem: "INGEST" | "GENERATE" | "SCHEDULE" | "PUBLISH" | "HEALTH";
  message: string;
  postId?: string;
  errorStack?: string;
  metaJson?: string;
};

export type AccountScope = {
  accountKey?: string;
  treatBlankAccountKeyAsMatch?: boolean;
};

export interface DataStore {
  listActiveDonors(params: AccountScope & { maxRecords: number }): Promise<Donor[]>;
  touchDonorFetchedAt(params: { donorId: string; fetchedAtIso: string }): Promise<void>;
  updateDonor(params: { donorId: string; status?: "Active" | "Inactive"; notes?: string }): Promise<void>;

  hasPostBySeedUrl(params: AccountScope & { seedUrl: string }): Promise<boolean>;
  hasPostBySeedHash(params: AccountScope & { seedHash: string }): Promise<boolean>;

  createSeedPost(params: {
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
  }): Promise<{ postId: string }>;

  listPostsForGenerate(params: AccountScope & { maxRecords: number; recordIds?: string[] }): Promise<Post[]>;
  markPostGenerated(params: {
    postId: string;
    format: string;
    language: Language;
    threadParts: string[];
    threadPreview: string;
    ctaText: string;
    ctaUrl: string;
  }): Promise<void>;
  markPostFailed(params: { postId: string; subsystem: "GENERATE" | "PUBLISH"; errorMessage: string }): Promise<void>;

  listStuckPublishing(params: AccountScope & { maxRecords: number }): Promise<Array<Pick<Post, "id" | "lastAttemptAt" | "attemptCount" | "error" | "threadsRootId">>>;
  listPublishablePosts(
    params: AccountScope & { maxRecords: number; recordIds?: string[] }
  ): Promise<Array<Post>>;

  updatePostForPublishAttempt(params: {
    postId: string;
    postStatus: PostStatus;
    error?: string;
    lastAttemptAtIso?: string;
    attemptCount?: number;
    failureSubsystem?: "PUBLISH" | "GENERATE" | null;
    threadsRootId?: string;
  }): Promise<void>;

  markPostPublished(params: { postId: string; publishedAtIso: string; threadsRootId: string; threadsRootUrl: string }): Promise<void>;

  listScheduledPosts(params: AccountScope & { maxRecords: number }): Promise<Array<Pick<Post, "id" | "scheduledAt" | "seedUrl">>>;
  hasQueuePosts(params: AccountScope): Promise<boolean>;
  getLastPublishedAt(params: AccountScope): Promise<string | undefined>;

  createRunLog?(log: RunLog): Promise<void>;
  cleanupRunLogs?(params: { thresholdRecords: number; trimToRecords: number }): Promise<void>;
}
