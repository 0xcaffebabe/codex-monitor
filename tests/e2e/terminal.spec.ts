import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const windows = process.platform === 'win32';
let token = '';
let restore: (() => void) | undefined;
let localCwd = '';

async function enter(page: Page, request: APIRequestContext, workspace = 'local') {
  if (
    !token ||
    !(await request.get('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })).ok()
  ) {
    const status = await (await request.get('/api/auth/status')).json();
    const response = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
      data: {
        username: 'owner',
        password: 'monitor-e2e-password!',
        ...(!status.configured
          ? {
              setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim(),
            }
          : {}),
      },
    });
    expect(response.ok()).toBeTruthy();
    token = (await response.json()).token;
  }
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  await page.goto(`/?workspace=${workspace}&session=${ids.modern}`);
  await expect(page.getByRole('button', { name: '项目工具', exact: true })).toBeVisible();
}

async function open(page: Page) {
  await page.getByRole('button', { name: '项目工具', exact: true }).click();
  await page.getByRole('button', { name: '打开项目终端', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目终端', exact: true });
  await expect(input(dialog)).toBeEditable();
  await expect(input(dialog)).toBeFocused();
  await expect(dialog.getByRole('button', { name: '执行', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.project-terminal-command')).toHaveCount(0);
  if (windows) await expect(dialog.locator('.xterm-accessibility-tree')).toContainText('PS ');
  else {
    // macOS zsh binds End in application mode; normalize this disposable shell
    // to xterm's normal-mode sequence for the keyboard forwarding assertions.
    await command(
      dialog,
      "export PS1='CM_E2E_PROMPT> '; if [ -n \"${ZSH_VERSION:-}\" ]; then bindkey '^[[F' end-of-line; fi",
      false,
    );
  }
  await waitForPrompt(dialog);
  return dialog;
}
async function waitForPrompt(dialog: Locator) {
  await expect
    .poll(
      async () =>
        (await output(dialog).innerText())
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) ?? '',
    )
    .toMatch(windows ? />$/ : /CM_E2E_PROMPT>$/);
}
async function command(dialog: Locator, text: string, shell = true) {
  if (shell) await waitForPrompt(dialog);
  await input(dialog).focus();
  await input(dialog).evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  }, text);
  await input(dialog).press('Enter');
}
const input = (dialog: Locator) => dialog.getByRole('textbox', { name: '终端输入', exact: true });
const output = (dialog: Locator) => dialog.locator('.xterm-accessibility-tree');

test.beforeEach(async ({}, info) => {
  const stores: { db: DatabaseSync; cwd: string }[] = [];
  for (const [index, folder] of [root, path.join(root, 'client-b')].entries()) {
    const db = new DatabaseSync(path.join(folder, 'codex/state_5.sqlite'));
    const cwd = String(db.prepare('SELECT cwd FROM threads WHERE id=?').get(ids.modern)!.cwd);
    stores.push({ db, cwd });
    const terminalCwd = path.join(folder, `terminal 项目 ${info.project.name} ${index}`);
    mkdirSync(path.join(terminalCwd, 'child'), { recursive: true });
    db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(terminalCwd, ids.modern);
    if (!index) localCwd = terminalCwd;
  }
  restore = () => {
    for (const { db, cwd } of stores) {
      db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(cwd, ids.modern);
      db.close();
    }
  };
});
test.afterEach(async ({ page }) => {
  const close = page.getByRole('button', { name: '关闭项目终端', exact: true });
  if (await close.isVisible()) await close.click();
  restore?.();
  restore = undefined;
});

test('project terminal executes in the project, preserves shell state, accepts interactive input and cleans up', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await enter(page, request);
  const opened = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/terminal'),
  );
  let dialog = await open(page);
  const info = await (await opened).json();
  expect(info.cwd).toBe(localCwd);
  await page.keyboard.type(
    windows ? "Write-Output ('KEYBOARD_'+'OX')" : "printf 'KEYBOARD_%s\\n' OX",
  );
  for (let i = 0; i < (windows ? 3 : 1); i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  await page.keyboard.type('K');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(output(dialog)).toContainText('KEYBOARD_OK');
  await waitForPrompt(dialog);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await output(dialog).innerText()).match(/KEYBOARD_OK/g)?.length)
    .toBe(2);
  await waitForPrompt(dialog);
  await page.keyboard.type('cd chi');
  await page.keyboard.press('Tab');
  await expect(input(dialog)).toBeFocused();
  await page.keyboard.press('Enter');
  await command(
    dialog,
    windows
      ? "Write-Output ('COMPLETED_' + (Split-Path -Leaf (Get-Location).Path)); Set-Location .."
      : 'printf \'COMPLETED_%s\\n\' "${PWD##*/}"; cd ..',
  );
  await expect(output(dialog)).toContainText('COMPLETED_child');
  await command(
    dialog,
    windows
      ? "Set-Content -LiteralPath cwd.txt -Encoding UTF8 -Value (Get-Location).Path; $env:TERMINAL_E2E='中文'; Set-Location child"
      : "pwd > cwd.txt; export TERMINAL_E2E='中文'; cd child",
  );
  await command(
    dialog,
    windows
      ? "Write-Output ('STATE_' + $env:TERMINAL_E2E); Write-Output ('DIR_' + (Split-Path -Leaf (Get-Location).Path))"
      : 'printf \'STATE_%s\\nDIR_%s\\n\' "$TERMINAL_E2E" "${PWD##*/}"',
  );
  await expect(output(dialog)).toContainText('STATE_中文');
  await expect(output(dialog)).toContainText('DIR_child');
  expect(readFileSync(path.join(localCwd, 'cwd.txt'), 'utf8').trim()).toBe(localCwd);
  await command(
    dialog,
    windows
      ? "$reply=Read-Host 'INTERACTIVE_PROMPT'; Write-Output ('REPLY_' + $reply)"
      : "printf 'INTERACTIVE_PROMPT'; IFS= read -r reply; printf 'REPLY_%s\\n' \"$reply\"",
  );
  await expect(output(dialog)).toContainText('INTERACTIVE_PROMPT');
  await command(dialog, 'shell-answer', false);
  await expect(output(dialog)).toContainText('REPLY_shell-answer');
  await command(
    dialog,
    windows
      ? "Write-Output ('LINE_'+'ONE')\nWrite-Output ('LINE_'+'TWO')"
      : "printf 'LINE_%s\\n' ONE\nprintf 'LINE_%s\\n' TWO",
  );
  await expect(output(dialog)).toContainText('LINE_ONE');
  await expect(output(dialog)).toContainText('LINE_TWO');
  await command(
    dialog,
    windows
      ? "Write-Output ('STREAM_'+'BEGIN'); Start-Sleep 30; Write-Output ('UNEXPECTED_'+'END')"
      : "printf 'STREAM_%s\\n' BEGIN; sleep 30; printf 'UNEXPECTED_%s\\n' END",
  );
  await expect(output(dialog)).toContainText('STREAM_BEGIN');
  await page.keyboard.press('Control+c');
  await expect(output(dialog)).toContainText(
    windows ? /STREAM_BEGIN[\s\S]*PS / : /STREAM_BEGIN[\s\S]*CM_E2E_PROMPT> /,
  );
  await command(
    dialog,
    windows ? "Write-Output ('AFTER_'+'INTERRUPT')" : "printf 'AFTER_%s\\n' INTERRUPT",
  );
  await expect(output(dialog)).toContainText('AFTER_INTERRUPT');
  await expect(output(dialog)).not.toContainText('UNEXPECTED_END');
  await command(
    dialog,
    windows
      ? "Write-Output ('BUTTON_'+'BEGIN'); Start-Sleep 30"
      : "printf 'BUTTON_%s\\n' BEGIN; sleep 30",
  );
  await expect(output(dialog)).toContainText('BUTTON_BEGIN');
  await dialog.getByRole('button', { name: /中断命令/ }).click();
  await expect(input(dialog)).toBeFocused();
  await waitForPrompt(dialog);
  await dialog.getByRole('button', { name: '清空终端显示', exact: true }).click();
  await expect(input(dialog)).toBeFocused();
  await expect(output(dialog)).not.toContainText('BUTTON_BEGIN');
  await dialog.getByRole('heading', { name: '项目终端', exact: true }).click();
  await dialog.locator('.project-terminal-screen').click({ position: { x: 3, y: 3 } });
  await expect(input(dialog)).toBeFocused();
  await page.keyboard.type(
    windows ? "Write-Output ('DIRECT_'+'INPUT_READY')" : "printf 'DIRECT_%s\\n' INPUT_READY",
  );
  await page.keyboard.press('Enter');
  await expect(output(dialog)).toContainText('DIRECT_INPUT_READY');
  // Escape is also a shell key-sequence prefix, so check it after command input.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(input(dialog)).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('project-terminal-inline.png') });
  await page.setViewportSize({ width: 520, height: 740 });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.width <= 520 && box.y >= 0 && box.height <= 740;
    })
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath('project-terminal.png') });
  const closed = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().includes('/terminal/'),
  );
  await dialog.getByRole('button', { name: '关闭项目终端', exact: true }).click();
  expect((await closed).status()).toBe(204);
  expect(
    (
      await request.get(
        `/api/workspaces/local/sessions/${ids.modern}/terminal/${info.id}?after=0`,
        { headers: { Authorization: 'Bearer ' + token } },
      )
    ).status(),
  ).toBe(404);
  dialog = await open(page);
  await command(dialog, 'exit 7');
  await expect(dialog.getByRole('status')).toContainText('退出码 7');
  await expect(input(dialog)).not.toBeEditable();
  await dialog.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(input(dialog)).toBeEditable();
  await expect(input(dialog)).toBeFocused();
});

test('project terminals use the selected workspace client and report missing project directories', async ({
  page,
  request,
}) => {
  await enter(page, request, second);
  const opened = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/terminal'),
  );
  const dialog = await open(page);
  const info = await (await opened).json();
  expect(info.cwd).toContain(path.join('client-b', 'terminal 项目'));
  await command(
    dialog,
    windows
      ? "Set-Content -LiteralPath client-b.txt -Value ('CLIENT_'+'B')"
      : "printf 'CLIENT_%s' B > client-b.txt",
  );
  await expect.poll(() => existsSync(path.join(info.cwd, 'client-b.txt'))).toBe(true);
  expect(existsSync(path.join(localCwd, 'client-b.txt'))).toBe(false);
  await dialog.getByRole('button', { name: '关闭项目终端', exact: true }).click();
  const db = new DatabaseSync(path.join(root, 'client-b/codex/state_5.sqlite'));
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(
    path.join(root, 'missing-terminal-directory'),
    ids.modern,
  );
  db.close();
  await page.getByRole('button', { name: '项目工具', exact: true }).click();
  await page.getByRole('button', { name: '打开项目终端', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '项目终端' }).getByRole('alert')).toContainText(
    '项目目录不存在',
  );
});

test('uncertain shell input stops the terminal without automatically resending commands', async ({
  page,
  request,
}) => {
  await enter(page, request);
  const dialog = await open(page);
  let sends = 0;
  await page.route('**/terminal/*/input', async (route) => {
    if (!route.request().postDataJSON().data.includes('uncertain-command')) {
      await route.continue();
      return;
    }
    sends++;
    await route.fulfill({ status: 503, json: { error: '测试工作空间断开' } });
  });
  await command(dialog, 'echo uncertain-command');
  await expect(dialog.getByRole('alert')).toContainText('输入可能已送达');
  await expect(input(dialog)).not.toBeEditable();
  expect(sends).toBe(1);
});
