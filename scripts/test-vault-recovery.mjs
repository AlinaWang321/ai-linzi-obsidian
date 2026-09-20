import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const load = async path => { const r = await build({ entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false }); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`) }
const cache = await load('src/vault-run-journal.ts'), work = await load('src/vault-work-tools.ts'), core = await load('src/vault-agent-core.ts')
globalThis.window = { setTimeout, clearTimeout }
const journal = () => ({version:1,sessionId:'obsidian:test',taskId:'task',question:'处理资料',updatedAt:Date.now(),round:0,snapshots:[],reads:{},plan:[],summaries:{},drafts:{}})
let disk='', submits=0, polls=0
const j=journal()
const host={ uid:()=> 'stable-id',save:async()=>{disk=JSON.stringify(j)},progress:()=>{},sleep:async()=>{},request:async(path,init)=>{
 if(init.method==='POST'){submits++;if(submits===1) throw new Error('Failed to fetch'); return {status:'running'}}
 polls++;return polls===1?{status:'running'}:{status:'completed',ok:true,responseId:'resp'}
}}
assert.equal((await cache.recoverableVaultStep(host,j,{question:'q'})).responseId,'resp')
assert.equal(submits,2);assert.equal(polls,2);assert.equal(JSON.parse(disk).pending.requestId,'stable-id')
// A cold restart reuses the persisted operation, even when the prior POST's response was lost.
const recovered=JSON.parse(disk);let recoveredId
await cache.recoverableVaultStep({...host,request:async(_p,init)=>{recoveredId=init.body.requestId;return {status:'completed',ok:true}}},recovered,{question:'different'})
assert.equal(recoveredId,'stable-id')
const terminal=journal(); await assert.rejects(cache.recoverableVaultStep({...host,request:async()=>({status:'failed',error:'生成不完整'})},terminal,{}),/生成不完整/)
assert.equal(terminal.pending,undefined)
const stopped=journal(),abort=new AbortController();let cancelled=false
await assert.rejects(cache.recoverableVaultStep({...host,request:async(_p,init)=>{if(init.body?.action==='cancel'){cancelled=true;return{status:'cancelled'}}abort.abort();return {status:'running'}}},stopped,{},abort.signal), /已停止/)
assert.equal(cancelled,true); assert.equal(stopped.pending,undefined)
const x=journal(); work.runVaultWorkTool(x,'set_task_plan',{sourcePaths:['raw/a.md','raw/b.md']},()=>true)
work.recordWorkRead(x,'raw/a.md',JSON.stringify({offset:100,nextOffset:null,totalChars:200}))
assert.equal(x.reads['raw/a.md'],undefined,'tail page alone cannot mark complete')
work.recordWorkRead(x,'raw/a.md',JSON.stringify({offset:0,nextOffset:100,totalChars:200}))
assert.throws(()=>work.runVaultWorkTool(x,'save_research_note',{sourcePath:'raw/a.md',summary:'facts'},()=>true),/尚未完整读取/)
work.recordWorkRead(x,'raw/a.md',JSON.stringify({offset:100,nextOffset:null,totalChars:200}))
work.runVaultWorkTool(x,'save_research_note',{sourcePath:'raw/a.md',summary:'尾部事实 TAIL-A'},()=>true)
for(const p of ['output/a.md','output/b.md'])work.runVaultWorkTool(x,'stage_note_draft',{path:p,content:'# 完整草稿'},()=>false)
assert.throws(()=>work.runVaultWorkTool(x,'propose_staged_notes',{paths:['output/a.md','output/b.md']},()=>false),/尚未完整读取/)
work.recordWorkRead(x,'raw/b.md',JSON.stringify({offset:0,nextOffset:null,totalChars:20}))
const plan=core.extractVaultOrganizePlan(work.runVaultWorkTool(x,'propose_staged_notes',{paths:['output/a.md','output/b.md']},()=>false).plan)
assert.equal(plan.invalid,false);assert.equal(plan.plan.operations.length,2)
assert.throws(()=>work.runVaultWorkTool(x,'stage_note_draft',{path:'output/a.md',content:'bad'},()=>true),/已存在/)
for(const p of ['../secret.md','.obsidian/config.md','C:\\private.md','a/AGENTS.md'])assert.throws(()=>work.safeWorkPath(p))
x.snapshots=[{path:'raw/a.md',mtime:1,size:200}]
assert.equal(Boolean(cache.canResumeVaultRun(x,()=>({mtime:2,size:200}))),false)
assert.ok(cache.vaultRunMemory(x).includes('TAIL-A'))
assert.equal(core.isVaultBatchTask('读取 01_Raw\\IPs\\Linda达田 文件夹中的文件，总结达田的方法论，生成两个文档'),true)
assert.equal(core.isVaultBatchTask('读取 a.md、b.md，整理为档案'),true)
assert.equal(core.isVaultBatchTask('根据raw文件夹里面小A的资料，按模板生成客户档案'),false)
// Exercise the actual serializer with escape-heavy text, preserving all characters via cursors.
const text=readFileSync('src/vault-agent.ts','utf8');const fn=text.slice(text.indexOf('function outputJson('),text.indexOf('\nfunction fileExtension'))
const ts=await import('typescript');const js=ts.default.transpile(fn).replace('TOOL_OUTPUT_MAX_CHARS','18000')
const serialize=new Function(js+';return outputJson')()
const original='\\\n"汉'.repeat(6000);let offset=0,reassembled=''
while(offset<original.length){const page=JSON.parse(serialize({text:original.slice(offset,offset+16000),offset,totalChars:original.length,nextOffset:Math.min(offset+16000,original.length)<original.length?offset+16000:null}));assert.ok(JSON.stringify(page).length<=18000);reassembled+=page.text;offset=page.nextOffset??original.length}
assert.equal(reassembled,original)
console.log('vault recovery: PASS (disconnect, lost ACK, restart, cancel, failed result, complete pagination, multi-draft, path safety, source change)')

const storage=new Map(),app={vault:{configDir:'.custom-config',adapter:{exists:async p=>storage.has(p),mkdir:async p=>storage.set(p,''),write:async(p,s)=>storage.set(p,s),rename:async(a,b)=>{if(storage.has(b))throw new Error('Destination file already exists!');storage.set(b,storage.get(a));storage.delete(a)},read:async p=>storage.get(p),remove:async p=>storage.delete(p)}}}
await cache.saveVaultRun(app,x);await cache.saveVaultRun(app,x);assert.equal((await cache.loadVaultRun(app,x.sessionId)).summaries['raw/a.md'],'尾部事实 TAIL-A')
assert.ok([...storage.keys()].every(p=>p.startsWith('.custom-config/plugins/ai-linzi/vault-tasks')))
const cachePath=[...storage.keys()].find(p=>p.endsWith('.json'));const old=JSON.parse(storage.get(cachePath));old.updatedAt=Date.now()-86400001;storage.set(cachePath,JSON.stringify(old));assert.equal(await cache.loadVaultRun(app,x.sessionId),null)
console.log('vault private cache: PASS (custom config, atomic replacement, 24h expiry)')
