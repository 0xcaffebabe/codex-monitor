declare const __MONITOR_BUILD_COMMIT_AT__: number | null;
declare const __MONITOR_BUILD_DEPENDENCIES__: string;

export const buildCommitAt =
  typeof __MONITOR_BUILD_COMMIT_AT__ === 'undefined' ? null : __MONITOR_BUILD_COMMIT_AT__;
export const buildDependencies =
  typeof __MONITOR_BUILD_DEPENDENCIES__ === 'undefined' ? undefined : __MONITOR_BUILD_DEPENDENCIES__;
