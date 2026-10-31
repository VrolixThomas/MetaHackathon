// Local visual QA only. Uses an already-installed Playwright; installs nothing.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const playwrightPath = process.env.MUSE_PLAYWRIGHT_PATH || '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright';
const { chromium } = require(playwrightPath);
const root = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.MUSE_CHROMIUM_PATH || '/Users/Werk/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const page = await browser.newPage({ viewport: { width:1440,height:1100 }, deviceScaleFactor:1 });
const errors = [], requests = [];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>requests.push(r.url()));
await page.goto(pathToFileURL(join(root,'index.html')).href);
await page.waitForTimeout(500);
assert.equal(await page.locator('.concept').count(),3);
assert.equal(await page.locator('[data-pose]').count(),8);
assert.equal(await page.locator('button[data-state][aria-pressed=true]').getAttribute('data-state'),'idle');
const idle = await page.locator('#hero [data-blade]').first().getAttribute('transform');
await page.waitForTimeout(150);
assert.equal(await page.locator('#hero [data-blade]').first().getAttribute('transform'),idle,'Idle is still');
await page.screenshot({ path:join(root,'screenshots/01-overview.png'),fullPage:true });
for(const direction of ['cadence','lumen','openfold']) {
 await page.locator(`[data-direction="${direction}"]`).click();
 assert.equal(await page.locator('#download-mark').getAttribute('href'),`assets/${direction}/mark-ink.svg`);
 await page.locator('button[data-state="listening"]').click();
 await page.locator('#amplitude').fill('0');
 await page.waitForTimeout(650);
 const low = await page.locator('#hero [data-blade]').first().getAttribute('transform');
 await page.locator('#amplitude').fill('1');
 await page.waitForTimeout(650);
 assert.notEqual(await page.locator('#hero [data-blade]').first().getAttribute('transform'),low,'Amplitude moves blades');
 for(const state of ['thinking','speaking','needs-input','success','error','offline','idle']) {
  await page.locator(`button[data-state="${state}"]`).click();
  assert.equal(await page.locator('#hero svg').getAttribute('data-state'),state);
 }
}
await page.locator('button[data-state="speaking"]').click();
await page.locator('#amplitude').fill('0.8');
await page.waitForTimeout(700);
await page.locator('.lab').screenshot({path:join(root,'screenshots/02-speaking-simulation.png')});
await page.locator('#simulate').check();
await page.waitForTimeout(150);
assert.notEqual(await page.locator('#amplitude').inputValue(),'0.8','Simulated amplitude varies');
await page.locator('#reduced').check();
assert.equal(await page.locator('#simulate').isEnabled(),false,'Reduction disables automatic amplitude');
assert.equal(await page.locator('#simulate').isChecked(),false);

await page.waitForTimeout(100);
const reduced = await page.locator('#hero [data-blade]').first().getAttribute('transform');
await page.locator('#amplitude').fill('0.1');
await page.waitForTimeout(100);
assert.equal(await page.locator('#hero [data-blade]').first().getAttribute('transform'),reduced,'Reduced motion ignores amplitude');
await page.locator('[data-signal="listening"]').check();
await page.locator('[data-signal="speaking"]').check();
assert.match(await page.locator('#signal-result').textContent(),/speaking$/);
await page.locator('[data-signal="offline"]').check();
assert.match(await page.locator('#signal-result').textContent(),/offline$/);
await page.locator('[data-signal="error"]').check();
assert.match(await page.locator('#signal-result').textContent(),/error$/);
await page.locator('[data-signal="error"]').uncheck();
await page.locator('[data-signal="offline"]').uncheck();
await page.locator('[data-signal="speaking"]').uncheck();
await page.locator('[data-signal="listening"]').uncheck();
await page.locator('button[data-state="listening"]').click();
await page.emulateMedia({reducedMotion:'reduce'});
await page.locator('#reduced').uncheck();
await page.waitForTimeout(100);
assert.equal(await page.locator('#motion-mode').textContent(),'System: reduced motion');
const systemReduced = await page.locator('#hero [data-blade]').first().getAttribute('transform');
await page.locator('#amplitude').fill('1');
await page.waitForTimeout(100);
assert.equal(await page.locator('#hero [data-blade]').first().getAttribute('transform'),systemReduced,'OS preference always wins');
// Validate exported static vectors against the rendered reduced-motion poses.
for (const state of ['idle','listening','thinking','speaking','needs-input','success','error','offline']) {
 const live = await page.locator(`[data-pose="${state}"] [data-blade]`).evaluateAll(nodes => nodes.map(n=>n.getAttribute('transform')));
 for(const theme of ['light','dark']) {
  const source=readFileSync(join(root,`assets/openfold/static/${state}-${theme}.svg`),'utf8');
  const transforms=[...source.matchAll(/<path d="[^"]+" transform="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(transforms.length,2);
  transforms.forEach((transform,i)=>{
   const numbers=transform.match(/-?\d+(?:\.\d+)?/g).map(Number);
   const expected=live[i].match(/-?\d+(?:\.\d+)?/g).map(Number);
   assert.equal(numbers.length,expected.length);
   numbers.forEach((n,j)=>assert.ok(Math.abs(n-expected[j])<0.0001,'Static export matches live pose'));
  });
 }
}
await page.locator('[data-theme="light"]').click();
assert.equal(await page.locator('#stage').evaluate(el=>el.classList.contains('light')),true);
await page.locator('[data-theme="dark"]').click();
await page.locator('#sequence').click();
assert.equal(await page.locator('#sequence').getAttribute('aria-pressed'),'true');
await page.locator('#sequence').click();
assert.equal(await page.locator('#tour-progress').textContent(),'Manual control');
await page.locator('.proofs').screenshot({path:join(root,'screenshots/03-size-and-treatment.png')});
await page.locator('#state-board').screenshot({path:join(root,'screenshots/04-static-states.png')});
await page.setViewportSize({width:390,height:844});
await page.locator('button[data-state="idle"]').click();
await page.screenshot({path:join(root,'screenshots/05-mobile.png'),fullPage:true});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,'Mobile does not overflow');
assert.deepEqual(errors,[],'No browser errors');
assert.equal(requests.filter(u=>/^https?:/.test(u)).length,0,'No network requests');
const report={artifact:'Muse logo / motion design simulation',browser:await browser.version(),checks:['three directions','all eight states per direction','static idle','amplitude response','manual and OS reduced motion','precedence','static SVG/live-pose parity','light/dark controls','simulated amplitude','manual tour start/stop','mobile width','zero browser errors','zero network requests'],viewport:[1440,1100],mobile:[390,844],screenshots:5,errors,externalRequests:0,limits:'Browser design simulation only; no Electron, provider, microphone or actual product-state integration.'};
writeFileSync(join(root,'validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
await browser.close();
