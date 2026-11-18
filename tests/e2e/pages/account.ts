import type { Page } from '@playwright/test';

type Credentials = { username: string; password: string };

export class AccountPage {
  readonly signInHeading;
  readonly loginError;
  readonly rememberDevice;

  constructor(private readonly page: Page) {
    this.signInHeading = page.getByRole('heading', { name: '连接工作空间', exact: true });
    this.loginError = page.getByRole('alert');
    this.rememberDevice = page.getByRole('checkbox', { name: /记住此设备/ });
  }

  async setUpOwner(setupKey: string, credentials: Credentials, destination = '/') {
    await this.page.goto(destination);
    await this.page.getByLabel('初始化密钥', { exact: true }).fill(setupKey);
    await this.fillCredentials(credentials);
    await this.page.getByRole('button', { name: '创建并进入', exact: true }).click();
  }

  async logIn(credentials: Credentials) {
    await this.fillCredentials(credentials);
    await this.page.getByRole('button', { name: '进入工作空间', exact: true }).click();
  }

  async logOut() {
    await this.page.getByTitle('退出登录', { exact: true }).click();
  }

  private async fillCredentials(credentials: Credentials) {
    await this.page.getByLabel('用户名', { exact: true }).fill(credentials.username);
    await this.page.getByLabel('密码', { exact: true }).fill(credentials.password);
  }
}
