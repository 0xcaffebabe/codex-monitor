import type { Page } from '@playwright/test';

export class WorkspacePage {
  readonly activityHeading;
  readonly sessionListHeading;
  readonly workspaceSelector;
  readonly offlineNotice;
  readonly navigation;
  readonly projects;
  readonly projectScope;
  readonly sessionScope;

  constructor(private readonly page: Page) {
    this.activityHeading = page.getByRole('heading', { name: '任务动态', exact: true });
    this.sessionListHeading = page.getByRole('heading', { name: '全部会话', exact: true });
    this.workspaceSelector = page.getByLabel('切换工作空间');
    this.offlineNotice = page.getByText(/此工作空间已离线/);
    this.navigation = page.getByRole('complementary', { name: '工作空间导航' });
    this.projects = this.navigation.getByRole('navigation', { name: '项目列表' });
    this.projectScope = this.navigation.getByLabel('筛选项目工作空间');
    this.sessionScope = page.getByLabel('筛选会话工作空间');
  }

  async switchTo(workspaceId: string) {
    await this.workspaceSelector.selectOption(workspaceId);
  }

  async showArchivedSessions() {
    await this.page.getByRole('button', { name: '已归档', exact: true }).click();
  }

  async showMobileProjects() {
    await this.page.getByRole('button', { name: '打开菜单' }).tap();
    await this.navigation.getByRole('button', { name: '项目', exact: true }).tap();
  }

  projectGroup(workspaceName: string) {
    return this.projects.getByRole('region', { name: workspaceName, exact: true });
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
