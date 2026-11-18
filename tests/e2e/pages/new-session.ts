import type { Page } from '@playwright/test';
import type { SessionPermissionMode } from '../../../src/approval-types.js';

export class NewSessionPage {
  private readonly composer;
  readonly permissions;

  constructor(private readonly page: Page) {
    this.composer = page.getByRole('region', { name: '新建会话', exact: true });
    this.permissions = this.composer.getByLabel('新会话权限');
  }

  async open() {
    await this.page.getByRole('button', { name: '新建会话', exact: true }).click();
  }

  async choosePermissions(mode: SessionPermissionMode) {
    await this.permissions.selectOption(mode);
  }

  async createAndSend(prompt: string) {
    await this.composer.getByLabel('发送给 Codex 的消息', { exact: true }).fill(prompt);
    await this.composer.getByRole('button', { name: '创建并发送', exact: true }).click();
  }
}
