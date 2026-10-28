// Load each UI graph into the real ComfyUI frontend, convert it with graphToPrompt,
// save the API prompt the frontend produces, and collect console errors + a screenshot.
// usage: node roundtrip.js <comfy url> <ui dir> <out dir> [shot ids comma-separated]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [url, uiDir, outDir, shotList] = process.argv.slice(2);
  const shots = new Set((shotList || '').split(',').filter(Boolean));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window.app || window.comfyAPI?.app?.app)?.graph, null, { timeout: 120000 });
  await page.waitForTimeout(5000); // let extensions finish starting up so their errors are not blamed on a graph
  const results = {};
  for (const file of fs.readdirSync(uiDir).filter((f) => f.endsWith('.json')).sort()) {
    const id = file.replace(/\.json$/, '');
    errors.length = 0;
    const graph = JSON.parse(fs.readFileSync(path.join(uiDir, file), 'utf8'));
    let res;
    try {
      res = await page.evaluate(async ({ graph, id }) => {
        const app = window.app || window.comfyAPI.app.app;
        await app.loadGraphData(graph, true, true, id);
        await new Promise((r) => setTimeout(r, 400));
        const p = await app.graphToPrompt();
        const nodes = app.graph._nodes || app.graph.nodes;
        const missing = nodes.filter((n) => n.has_errors || n.type === undefined || (n.constructor && n.constructor.name === 'LGraphNode' && !n.comfyClass)).map((n) => n.type);
        return { output: p.output, nodeCount: nodes.length, missing };
      }, { graph, id });
    } catch (e) {
      res = { error: String(e).slice(0, 500) };
    }
    if (shots.has(id)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.screenshot({ path: path.join(outDir, `${id}.png`) });
    }
    res.consoleErrors = [...errors];
    results[id] = res;
    fs.writeFileSync(path.join(outDir, `${id}.prompt.json`), JSON.stringify(res.output || {}, null, 1));
    console.log(`${id}: ${res.error ? 'ERROR ' + res.error : Object.keys(res.output || {}).length + ' api nodes'}${res.consoleErrors.length ? ', ' + res.consoleErrors.length + ' console errors' : ''}`);
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  await browser.close();
})();
