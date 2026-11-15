import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

export function launchBrowser() {
  const executablePath = process.env.CHROME_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
  return chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}

/** Optional review artifacts belong outside the repository, never in routine output. */
export async function capture(page: import('playwright-core').Page, name: string) {
  if (!process.env.SCREENSHOT_DIR) return;
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}
