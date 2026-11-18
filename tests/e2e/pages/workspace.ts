import type { Page } from '@playwright/test';

export class WorkspacePage {
  readonly activityHeading;
  readonly sessionListHeading;
  readonly workspaceSelector;
  readonly offlineNotice;

  constructor(private readonly page: Page) {
    this.activityHeading = page.getByRole('heading', { name: '任务动态', exact: true });
    this.sessionListHeading = page.getByRole('heading', { name: '全部会话', exact: true });
    this.workspaceSelector = page.getByLabel('切换工作空间');
    this.offlineNotice = page.getByText(/此工作空间已离线/);
  }

  async switchTo(workspaceId: string) {
    await this.workspaceSelector.selectOption(workspaceId);
  }

  async showArchivedSessions() {
    await this.page.getByRole('button', { name: '已归档', exact: true }).click();
  }

  sessionRow(title: string) {
    return this.page.getByTestId('session-row').filter({ hasText: title });
  }

  async openSession(title: string) {
    await this.sessionRow(title).click();
  }

  async tapSession(title: string) {
    await this.sessionRow(title).tap();
  }
}
