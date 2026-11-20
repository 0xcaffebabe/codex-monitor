import type { Page } from '@playwright/test';
import { AccountPage } from './account.js';
import { NewSessionPage } from './new-session.js';
import { SessionPage } from './session.js';
import { UsagePage } from './usage.js';
import { WorkspacePage } from './workspace.js';

export class MonitorPage {
  readonly account: AccountPage;
  readonly workspace: WorkspacePage;
  readonly session: SessionPage;
  readonly newSession: NewSessionPage;
  readonly usage: UsagePage;

  constructor(readonly browserPage: Page) {
    this.account = new AccountPage(browserPage);
    this.workspace = new WorkspacePage(browserPage);
    this.session = new SessionPage(browserPage);
    this.newSession = new NewSessionPage(browserPage);
    this.usage = new UsagePage(browserPage);
  }

  async newTab() {
    return new MonitorPage(await this.browserPage.context().newPage());
  }
}
