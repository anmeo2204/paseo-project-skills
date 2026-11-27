export const previewLimits = {
  files: 2048,
  pathBytes: 1024,
  pathDepth: 32,
  fileBytes: 1024 * 1024,
  readBytes: 8 * 1024 * 1024,
  filesystemChecks: 32768,
  diffBytes: 128 * 1024,
  responseBytes: 1024 * 1024,
  deadlineMs: 8000,
} as const;
