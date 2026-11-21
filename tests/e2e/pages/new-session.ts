import type { Page } from '@playwright/test';
import type { SessionPermissionMode } from '../../../src/approval-types.js';

export class NewSessionPage {
  private readonly composer;
  readonly permissions;
  readonly draft;

  constructor(private readonly page: Page) {
    this.composer = page.getByRole('region', { name: '新建会话', exact: true });
    this.permissions = this.composer.getByLabel('新会话权限');
    this.draft = this.composer.getByLabel('发送给 Codex 的消息', { exact: true });
  }

  async open() {
    await this.page.getByRole('button', { name: '新建会话', exact: true }).click();
  }

  async choosePermissions(mode: SessionPermissionMode) {
    await this.permissions.selectOption(mode);
  }

  workspaceTab(name: string | RegExp) {
    return this.composer.getByRole('tablist', { name: '工作空间' }).getByRole('tab', { name, exact: true });
  }

  project(name: string) {
    return this.composer.getByRole('radiogroup', { name: '项目' }).getByRole('radio', { name, exact: true });
  }

  async createAndSend(prompt: string) {
    await this.draft.fill(prompt);
    await this.composer.getByRole('button', { name: '创建并发送', exact: true }).click();
  }
}
