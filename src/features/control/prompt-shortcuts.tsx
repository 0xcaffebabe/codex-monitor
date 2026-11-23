import { CloudUpload, GitCommitHorizontal, Monitor, Upload } from 'lucide-react';
import type { ReactNode } from 'react';

export type PromptShortcut = {
  id: string;
  label: string;
  description: string;
  group: string;
  prompt: string;
  icon: ReactNode;
  channel?: 'desktop';
  keywords?: string[];
};

export type ComposerAction = {
  id: string;
  label: string;
  description: string;
  render: (close: () => void) => ReactNode;
};

export const promptShortcuts: PromptShortcut[] = [
  {
    id: 'computer-use',
    label: 'Computer Use',
    description: '切换桌面通道并发送权限提示',
    group: '电脑操作',
    prompt: '已切换为桌面端通道，开通了 computer use 权限',
    icon: <Monitor size={17} />,
    channel: 'desktop',
    keywords: ['桌面', '电脑', '权限'],
  },
  {
    id: 'commit-code',
    label: '提交代码',
    description: '检查改动并编写提交说明',
    group: '代码协作',
    prompt: '请检查并提交本次任务相关的代码改动，编写清晰的提交说明。',
    icon: <GitCommitHorizontal size={17} />,
    keywords: ['git', 'commit'],
  },
  {
    id: 'push-code',
    label: '推送代码',
    description: '将当前分支推送到远程',
    group: '代码协作',
    prompt: '请将当前分支的代码推送到对应的远程分支。',
    icon: <CloudUpload size={17} />,
    keywords: ['git', 'push'],
  },
  {
    id: 'commit-and-push-code',
    label: '提交并推送代码',
    description: '提交本次改动并推送当前分支',
    group: '代码协作',
    prompt: '请检查本次任务相关的代码改动，编写清晰的提交说明并提交，然后将当前分支推送到对应的远程分支。',
    icon: <Upload size={17} />,
    keywords: ['git', 'commit', 'push', '提交推送'],
  },
];
