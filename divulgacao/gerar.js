// Gera as artes de divulgação em PNG com o Chrome headless:
//   node divulgacao/gerar.js   ->  divulgacao/instagram-feed.png (1080×1350) e instagram-story.png (1080×1920)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error('Chrome/Edge não encontrado (defina CHROME=caminho)');


for (const [nome, altura, query, arquivo = 'arte.html'] of [
  ['instagram-feed.png', 1350, ''],
  ['instagram-story.png', 1920, '?story'],
  ['instagram-story-pessoal.png', 1920, '', 'story-pessoal.html'],
]) {
  const saida = path.join(DIR, nome);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=1080,${altura}`, '--virtual-time-budget=2000', `--screenshot=${saida}`, pathToFileURL(path.join(DIR, arquivo)).href + query,
  ], { stdio: 'ignore' });
  console.log(`${nome}: ${(fs.statSync(saida).size / 1024).toFixed(0)} KB`);
}
