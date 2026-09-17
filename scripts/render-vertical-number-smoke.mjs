import { execFile } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const exec = promisify(execFile)
const project = process.argv[2]
  ? path.resolve(process.argv[2])
  : await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-vertical-number-smoke-'))
await mkdir(path.join(project, 'audio'), { recursive: true })

const bundle = path.join(project, 'article-video-runtime-smoke.mjs')
await build({
  entryPoints: [path.resolve('src/article-video-runtime.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'obsidian-smoke-stub',
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'smoke' }))
      builder.onLoad({ filter: /.*/, namespace: 'smoke' }, () => ({
        loader: 'js',
        contents: `
          export class FileSystemAdapter {}
          export class FuzzySuggestModal { constructor() {} }
          export class Modal { constructor() {} }
          export class Notice {}
          export class Setting {}
          export class TFile {}
          export const normalizePath = (value) => value
          export const requestUrl = async () => ({})
        `,
      }))
    },
  }],
})

const { buildVerticalProjectHtml } = await import(pathToFileURL(bundle).href)
const scenes = [{
  id: 'number',
  type: 'number',
  headline: '一年后线上销售额翻倍',
  support: '只动了 7 刀，没有增加广告预算',
  voiceover: '一年后，线上销售额从一千六百万涨到三千二百万。',
  number: '1600万→3200万',
  unit: '年销售额',
}]
const timings = {
  totalDuration: 4,
  scenes: [{ id: 'number', start: 0, duration: 4, end: 4 }],
}
await buildVerticalProjectHtml(project, {
  title: '292号合伙人竖版数字页排版验证',
  durationTarget: 30,
  brand: { name: 'AI霖子', background: '#FFFBEA', primary: '#173B6C', accent: '#F28C28' },
  scenes,
}, timings)
await exec('/opt/homebrew/bin/ffmpeg', [
  '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '4',
  '-c:a', 'pcm_s16le', path.join(project, 'audio', 'narration.wav'),
])
console.log(project)
