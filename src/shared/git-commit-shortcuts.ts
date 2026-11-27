export const commitCodeShortcut = {
  id: 'commit-code',
  label: '提交代码',
  prompt: '请检查并提交本次任务相关的代码改动，编写清晰的提交说明。',
};

export const commitAndPushCodeShortcut = {
  id: 'commit-and-push-code',
  label: '提交并推送代码',
  prompt: '请检查本次任务相关的代码改动，编写清晰的提交说明并提交，然后将当前分支推送到对应的远程分支。',
};

export const gitCommitShortcuts = [commitCodeShortcut, commitAndPushCodeShortcut];
