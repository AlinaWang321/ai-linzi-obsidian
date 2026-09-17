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
  : await mkdtemp(path.join(os.tmpdir(), 'ai-linzi-horizontal-smoke-'))
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

const { buildHorizontalProjectHtml } = await import(pathToFileURL(bundle).href)
const scenes = [
  { id: 'hook', type: 'hook', eyebrow: '现实卡点', headline: '收入越高，为什么反而越累？', support: '问题不在能力，而在旧身份已经到顶', voiceover: '当收入越做越高，你却越来越累，真正卡住你的往往不是能力，而是旧身份已经到顶。' },
  { id: 'number', type: 'number', eyebrow: '体力上限', headline: '个人时间决定收入，也决定上限', support: '日程填满之后，再努力也没有新空间', voiceover: '当所有收入都依赖你的个人时间，日程一旦填满，增长也就碰到了体力上限。', number: '30-50万', unit: '个人产能区间' },
  { id: 'comparison', type: 'comparison', eyebrow: '错误扩张', headline: '多一个人，不等于多一套机制', support: '没有权责利，协作只会增加管理负担', voiceover: '多一个人并不等于多一套机制。权责利没有说清楚，协作只会变成新的管理负担。', left: { label: '误区', value: '先招人再分工' }, right: { label: '正解', value: '先定机制再组队' } },
  { id: 'flow', type: 'flow', eyebrow: '岗位拆分', headline: '先把工作拆成可以交接的岗位', support: '让责任沿着流程流动，而不是继续堆在你身上', voiceover: '先把引流、成交、交付和答疑拆成岗位，让责任沿着流程流动，而不是继续堆在你身上。', items: [{ title: '引流', detail: '找到客户' }, { title: '成交', detail: '确认需求' }, { title: '交付', detail: '兑现结果' }, { title: '答疑', detail: '持续支持' }] },
  { id: 'timeline', type: 'timeline', eyebrow: '身份换挡', headline: '增长，是四次身份换挡', support: '不是一直把同一个自己放大', voiceover: '从个人能力变成生意，需要经历独立教练、一人公司、机制设计者和组织运营者四次身份换挡。', items: [{ title: '独立教练' }, { title: '一人公司' }, { title: '机制设计' }, { title: '组织运营' }] },
  { id: 'steps', type: 'steps', eyebrow: '机制建立', headline: '机制成熟有三个台阶', support: '责任清楚、结果可判、价值可分', voiceover: '机制成熟至少有三个台阶，先把责任写清楚，再让结果可以判断，最后让价值能够分配。', items: [{ title: '责任清楚' }, { title: '结果可判' }, { title: '价值可分' }] },
  { id: 'quote', type: 'quote', eyebrow: '关键转折', headline: '不是所有人都要当老板，但都要找到下一种身份', support: '身份改变，收入结构才会改变', voiceover: '不是所有人都要当老板，但每个人都要找到自己的下一种身份。身份改变，收入结构才会改变。' },
  { id: 'summary', type: 'summary', eyebrow: '两条路径', headline: '五十万之后，只剩两条路', support: '自己设计机制，或者进入成熟生态承担结果', voiceover: '五十万之后只剩两条路，要么自己设计机制并承担全局结果，要么进入成熟生态，在关键岗位上跑通结果闭环。', items: [{ title: '自建规则与组织', detail: '设计机制，承担全局结果' }, { title: '成熟生态内创业', detail: '占住岗位，跑通结果闭环' }] },
]
const duration = 4
const timings = {
  totalDuration: scenes.length * duration,
  scenes: scenes.map((scene, index) => ({
    id: scene.id,
    start: index * duration,
    duration,
    end: (index + 1) * duration,
  })),
}
await buildHorizontalProjectHtml(project, {
  title: '教练做到年入50万，剩下的路只有两条',
  durationTarget: 30,
  brand: { name: 'AI霖子', background: '#050B16', primary: '#0057FF', accent: '#F39800' },
  scenes,
}, timings)
await exec('/opt/homebrew/bin/ffmpeg', [
  '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(timings.totalDuration),
  '-c:a', 'pcm_s16le', path.join(project, 'audio', 'narration.wav'),
])
console.log(project)
