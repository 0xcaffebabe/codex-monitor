import type { Page } from '@playwright/test';

export class SessionPage {
  readonly detail;
  readonly timeline;
  readonly draft;
  readonly liveSync;
  readonly approval;
  readonly allowOnce;

  constructor(private readonly page: Page) {
    this.detail = page.getByRole('region', { name: '会话详情', exact: true });
    this.timeline = this.detail.locator('.timeline');
    this.draft = this.detail.getByLabel('发送给 Codex 的消息', { exact: true });
    this.liveSync = page.getByTitle('实时同步', { exact: true });
    this.approval = this.detail.getByRole('region', { name: '权限审批' });
    this.allowOnce = this.approval.getByRole('button', { name: '允许本次', exact: true });
  }

  async open(workspaceId: string, sessionId: string) {
    const query = new URLSearchParams({ workspace: workspaceId, session: sessionId });
    await this.page.goto(`/?${query}`);
  }

  currentId() {
    return new URL(this.page.url()).searchParams.get('session');
  }

  heading(title: string) {
    return this.detail.getByRole('heading', { name: title, exact: true });
  }

  message(text: string) {
    return this.timeline.getByText(text, { exact: true });
  }

  markdownCell(text: string) {
    return this.timeline.getByRole('table').getByRole('cell', { name: text, exact: true });
  }

  forbiddenMarkdownElements(externalHost: string) {
    return this.timeline.locator(`script, img[src*="${externalHost}"]`);
  }

  async writeDraft(text: string) {
    await this.draft.fill(text);
  }

  async sendMessage(text: string) {
    await this.writeDraft(text);
    await this.detail.getByRole('button', { name: /^(发送|追加)消息$/ }).click();
  }

  async approveOnce() {
    await this.allowOnce.click();
  }

  async tapBackToList() {
    await this.detail.getByTitle('返回会话列表', { exact: true }).tap();
  }

  hasHorizontalOverflow() {
    return this.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  }
}
