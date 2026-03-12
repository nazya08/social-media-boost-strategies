export const Tables = {
  POSTS: "Posts",
  DONORS: "Threads Donors",
  RUN_LOGS: "Run Logs"
} as const;

export const PostFields = {
  Title: "Title",
  SeedText: "Seed Text",
  SeedUrl: "Seed URL",
  SeedPublishedAt: "Seed Published At",
  SeedAuthor: "Seed Author",
  SeedHash: "Seed Hash",
  MediaUrl: "Media URL",
  MediaType: "Media Type",
  MediaAltText: "Media Alt Text",
  Source: "Source",
  PostStatus: "Post Status",
  Format: "Format",
  Language: "Language",
  ThreadPartsJson: "Thread Parts JSON",
  ThreadPreview: "Thread Preview",
  CtaText: "CTA Text",
  CtaUrl: "CTA URL",
  AttributionUrl: "Attribution URL",
  ThreadsRootId: "Threads Root ID",
  ThreadsRootUrl: "Threads Root URL",
  ScheduledAt: "Scheduled At",
  PublishedAt: "Published At",
  AttemptCount: "Attempt Count",
  LastAttemptAt: "Last Attempt At",
  Error: "Error",
  FailureSubsystem: "Failure Subsystem",
  Tags: "Tags"
} as const;

export const DonorFields = {
  Username: "Username",
  ProfileUrl: "Profile URL",
  Platform: "Platform",
  FeedUrl: "Feed URL",
  Status: "Status",
  Language: "Language",
  LastFetchedAt: "Last Fetched At",
  Notes: "Notes"
} as const;

export const RunLogFields = {
  Timestamp: "Timestamp",
  Level: "Level",
  Subsystem: "Subsystem",
  Post: "Post",
  Message: "Message",
  ErrorStack: "Error Stack",
  MetaJson: "Meta JSON"
} as const;
