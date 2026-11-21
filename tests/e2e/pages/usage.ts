import type { Page } from '@playwright/test';

export class UsagePage {
  readonly sub2api;
  readonly settings;
  readonly relayAddress;
  readonly relayAdminKey;
  readonly subscriptions;
  readonly apiKeys;
  readonly callRecords;
  readonly callFilters;

  constructor(private readonly page: Page) {
    this.sub2api = page.getByRole('region', { name: 'Sub2API 用量', exact: true });
    this.settings = page.getByRole('dialog', { name: '设置与访问管理', exact: true });
    this.relayAddress = this.settings.getByLabel('Sub2API 站点地址');
    this.relayAdminKey = this.settings.getByLabel('管理员 Key', { exact: true });
    this.subscriptions = this.sub2api.getByRole('table', { name: '订阅账号用量', exact: true });
    this.apiKeys = this.sub2api.getByRole('table', { name: 'API Key 用量', exact: true });
    this.callRecords = this.sub2api.getByRole('table', { name: 'Sub2API 调用记录', exact: true });
    this.callFilters = this.sub2api.getByRole('form', { name: '筛选 Sub2API 调用记录' });
  }

  async open() {
    await this.page.getByRole('button', { name: '用量统计', exact: true }).click();
  }

  async configureSub2Api(baseUrl: string, adminKey: string) {
    await this.sub2api.getByRole('button', { name: '配置 Sub2API', exact: true }).click();
    await this.relayAddress.fill(baseUrl);
    await this.relayAdminKey.fill(adminKey);
    await this.settings.getByRole('button', { name: '保存 Sub2API 配置', exact: true }).click();
  }

  async closeSettings() {
    await this.settings.getByRole('button', { name: '完成', exact: true }).click();
  }

  subscriptionAccount(name: string) {
    return this.subscriptions.getByRole('row').filter({ hasText: name });
  }

  async refreshSub2Api() {
    await this.sub2api.getByRole('button', { name: '刷新 Sub2API 用量', exact: true }).click();
  }

  async selectSubscriptionType(type: 'oauth' | 'setup-token') {
    await this.sub2api.getByLabel('订阅账号类型').selectOption(type);
  }

  async showApiKeys() {
    await this.sub2api.getByRole('button', { name: 'API Key', exact: true }).click();
  }

  async showCallRecords() {
    await this.sub2api.getByRole('button', { name: '调用记录', exact: true }).click();
  }

  async queryCallRecords() {
    await this.callFilters.getByRole('button', { name: '查询记录', exact: true }).click();
  }

  apiKey(name: string) {
    return this.apiKeys.getByRole('row').filter({ hasText: name });
  }

  async selectKeyPeriod(days: '1' | '7' | '30') {
    await this.sub2api.getByLabel('Sub2API Key 统计时间范围').selectOption(days);
  }

  async searchKey(value: string) {
    await this.sub2api.getByLabel('Key 名称或 #ID').fill(value);
    await this.sub2api.getByRole('button', { name: '查询 Sub2API 用量', exact: true }).click();
  }
}
