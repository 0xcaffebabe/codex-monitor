declare const __MONITOR_BUILD_COMMIT_AT__: number | null;

export const buildCommitAt =
  typeof __MONITOR_BUILD_COMMIT_AT__ === 'undefined' ? null : __MONITOR_BUILD_COMMIT_AT__;
