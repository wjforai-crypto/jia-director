// Run explicitly on the installed local browser; this never records user acceptance.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { serveReview, readReview } from '../rough-review.mjs';
const root = resolve('.'), config = JSON.parse(await readFile(join(root, 'config/video-workflow.json'), 'utf8'));
const require = createRequire(pathToFileURL(join(root, 'runtime/hyperframes/package.json')));
const puppeteer = require('puppeteer-core');
const output = join(root, 'checks/2026-10-10/local-rough-review', `browser-${randomUUID()}`); await mkdir(output);
const fixture = process.argv[2] ? resolve(process.argv[2]) : join(root, 'checks/2026-10-10/local-rough-review/benchmark');
const project = join(output, 'review'); await cp(fixture, project, { recursive: true, errorOnExist: true, force: false });
const service = await serveReview(project), browser = await puppeteer.launch({ executablePath: config.render.browserPath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage(), errors = [], external = [], checks = [];
page.on('pageerror', e => errors.push(e.message)); page.on('request', req => { if (!req.url().startsWith(service.url) && !req.url().startsWith('data:')) external.push(req.url()); });
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
  await page.goto(service.url, { waitUntil: 'networkidle0' }); await page.waitForSelector('[data-unit]');
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.screenshot({ path: join(output, '01-panel-desktop.png'), fullPage: true });
  check('transcript rendered and no desktop horizontal overflow', await page.evaluate(() => document.querySelectorAll('[data-unit]').length === 226 && document.body.scrollWidth <= innerWidth));
  await page.click('[data-tab="suggestions"]');
  await page.click('#suggestions .suggestion:first-child .danger-outline');
  check('suggestion adopted as deletion', (await page.$$('#cuts .cut-row')).length === 1);
  await page.evaluate(async () => { const v = document.getElementById('video'); v.currentTime = 38.6; await v.play(); });
  await new Promise(res => setTimeout(res, 1400));
  const playback = await page.evaluate(() => { const v = document.getElementById('video'); v.pause(); return { sourceTime: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, readyState: v.readyState }; });
  check('continuous rough preview crosses deleted interval', playback.sourceTime > 42.8 && playback.frames > 0);
  await page.screenshot({ path: join(output, '02-deletion-preview.png'), fullPage: true });
  await page.click('#suggestions .suggestion:first-child .suggestion-actions button:last-child');
  check('restoration removes deletion', (await page.$$('#cuts .cut-row')).length === 0);
  await page.click('[data-tab="transcript"]');
  await page.click('[data-unit="u:seg_eb9f50b79865ae41:3"]');
  await page.$eval('#wordCorrection', el => { el.value = '想'; }); await page.click('#correctWord');
  check('word correction leaves video duration unchanged', (await page.$eval('#durationStats', el => el.textContent)).includes('移除 00:00.00'));
  await page.keyboard.press('Delete');
  check('partial cut requests fragment caption correction', !(await page.$eval('#captionWarning', el => el.textContent)).startsWith('0 '));
  while (await page.$('#captions .needs input')) {
    const flagged = await page.$('#captions .needs input'); await flagged.focus();
    // Explicitly accept the fragment text in this technical test; do not invent timing for the corrected whole sentence.
    await page.$eval('#captions .needs input', el => { el.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  await page.click('#save'); await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('r1'));
  await page.reload({ waitUntil: 'networkidle0' });
  check('reopened project preserves cut and caption correction', (await page.$$('#cuts .cut-row')).length === 1 && (await page.$eval('#captionWarning', el => el.textContent)).startsWith('0 '));
  await page.click('#cuts .cut-row button:last-child'); // restore the test-only word deletion
  await page.click('[data-tab="suggestions"]');
  for (const selector of ['#suggestions .suggestion:first-child .danger-outline', '#suggestions .suggestion:nth-child(2) .danger-outline']) await page.click(selector);
  await page.click('#export');
  await page.waitForFunction(() => document.querySelectorAll('#exports .export-row').length > 0 || document.getElementById('message').classList.contains('error'), { timeout: 120000 });
  if (!(await page.$('#exports .export-row'))) throw new Error(await page.$eval('#message', el => el.textContent));
  const current = await readReview(project); check('one saved decision source exports the two explicit semantic candidates', current.edits.cuts.length === 2);
  await page.$eval('#exports', el => el.closest('details').open = true); await page.click('#exports .export-row button');
  await page.waitForFunction(() => document.getElementById('video').currentTime > 1);
  const renderedPlayback = await page.evaluate(() => { const v = document.getElementById('video'); v.pause(); return { duration: v.duration, src: v.currentSrc, frames: v.getVideoPlaybackQuality().totalVideoFrames }; });
  check('actual exported MP4 plays in browser', renderedPlayback.src.includes('/exports/') && renderedPlayback.frames > 0 && renderedPlayback.duration < 58);
  await page.click('#roughMode');
  await page.screenshot({ path: join(output, '03-export-and-handoff.png'), fullPage: true });
  await page.setViewport({ width: 820, height: 1100 }); await page.screenshot({ path: join(output, '04-narrow-panel.png'), fullPage: true });
  check('narrow layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('zero runtime errors', errors.length === 0); check('zero external browser requests', external.length === 0);
  const receipt = { status: 'browser-technical-checks-passed', outputDir: output, projectDir: project, checks, playback, renderedPlayback, errors, externalRequests: external, userAcceptance: false, listeningCompleted: false, sourceArchiveModified: false };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' }); console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); await new Promise(res => service.server.close(res)); }
