// Opt-in real Codex verification; no user settings are changed.
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {MESSAGE} from "../core.mjs";
const BLOB_TYPES=new Set(["compaction","compaction_summary","context_compaction"]);
const KB_MARKER="[PI KB: sdp";

const sdkPath=process.env.PI_KB_SDK_PATH || join(
  execFileSync(process.platform==="win32" ? "npm.cmd" : "npm",["root","-g"],{encoding:"utf8"}).trim(),
  "@earendil-works/pi-coding-agent/dist/index.js"
);
const {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager}=await import(pathToFileURL(resolve(sdkPath)).href);
const agentDir=resolve(process.env.PI_KB_TEST_AGENT_DIR || join(homedir(),".pi/agent"));
const root=fileURLToPath(new URL("../test-artifacts/",import.meta.url));
const extensionPath=fileURLToPath(new URL("../index.mjs",import.meta.url));
await mkdir(root,{recursive:true,mode:0o700});
const runtime=await ModelRuntime.create();
const model=runtime.getModel("openai-codex","gpt-6.1-sol");
const settings=SettingsManager.inMemory({transport:"sse",compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:0},retry:{enabled:false}});
const requests=[], answers=[];
let phase="before", session, detachProbe;
function record(payload) {
  const input=payload.input||[];
  const kbIndex=input.findIndex(i=>i.role==="user"&&JSON.stringify(i).includes(KB_MARKER));
  const beforeIndex=input.findIndex(i=>JSON.stringify(i).includes("BEFORE_KB_BOUNDARY"));
  requests.push({phase,kbIndex,beforeIndex,kbPlain:kbIndex>=0,kbCount:input.filter(i=>JSON.stringify(i).includes(KB_MARKER)).length,blobs:input.filter(i=>BLOB_TYPES.has(i.type)).length,markers:input.some(i=>JSON.stringify(i).includes("[PI_KB:"))});
}
async function open(manager) {
  const loader=new DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,
    noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,
    additionalExtensionPaths:[process.env.PI_KB_COMPACT_TEST_PATH || join(agentDir,"npm/node_modules/@signalridge/pi-codex-compact/src/index.ts"),extensionPath],
    extensionFactories:[pi=>pi.on("before_provider_request",({payload})=>record(payload))],
    systemPrompt:"Answer concisely from supplied knowledge. No tools. Do not invent missing details."});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors,[]);
  const result=await createAgentSession({cwd:root,modelRuntime:runtime,model,thinkingLevel:"low",settingsManager:settings,resourceLoader:loader,sessionManager:manager,tools:[]});
  await result.session.bindExtensions({mode:"print",onError:e=>{throw new Error(e.error);}});
  // Observe compact's final input after our adapter expands the session anchor.
  const original=runtime.getProvider;
  function probe(...args) {
    const provider=original.apply(this,args);
    if(!provider)return provider;
    return new Proxy(provider,{get(target,key,receiver){
      if(key!=="stream")return Reflect.get(target,key,receiver);
      return (m,c,o)=>target.stream(m,c,{...o,onPayload:async payload=>{
        const result=(await o?.onPayload?.(payload))??payload;
        if(phase==="compact")record(result);
        return result;
      }});
    }});
  }
  runtime.getProvider=probe;
  detachProbe=()=>{runtime.getProvider=original;};
  return result.session;
}
function close() {detachProbe?.();session?.dispose();}
async function prompt(text) {
  await session.prompt(text);
  const last=session.messages.filter(m=>m.role==="assistant").at(-1);
  assert.ok(last);
  assert.notEqual(last.stopReason,"error",last.errorMessage);
  const answer=last.content.filter(b=>b.type==="text").map(b=>b.text).join("\n");
  answers.push({phase,answer});
  console.log(JSON.stringify({phase,answer}));
}
try {
  const manager=SessionManager.create(root,root+"/sessions");
  session=await open(manager);
  await prompt("BEFORE_KB_BOUNDARY。合言葉は『青い灯台』です。了解とだけ返答して。");
  await session.prompt("/kb sdp");
  const insertion=manager.getBranch().find(e=>e.customType===MESSAGE);
  assert.ok(insertion,"slash command inserted a custom_message into the session");
  assert.equal(insertion.type,"custom_message");
  const kb=insertion.details.snapshot;
  assert.ok(insertion.content.startsWith(KB_MARKER),"plaintext with preamble");
  assert.ok(insertion.content.includes("## Decrypted KB material:"));
  assert.ok(!JSON.stringify(insertion.details).includes("## Decrypted KB material:"),"details carry provenance only");
  assert.equal(kb.name,"sdp");
  phase="initial";
  await prompt("今挿入されたSDPの論文名と手法を200字程度で説明してください。");
  const path=manager.getSessionFile();
  close();
  session=await open(SessionManager.open(path));
  phase="resumed-before-compact";
  await prompt("その手法の狙いを一文で説明してください。");
  phase="compact";
  await session.compact("Preserve the passphrase and the supplied SDP knowledge.");
  const compact=session.sessionManager.getBranch().filter(e=>e.type==="compaction").at(-1);
  assert.equal(compact?.details?.kind,"pi-codex-remote-compaction");
  assert.ok(!JSON.stringify(compact.details.replacementHistory).includes(KB_MARKER));
  assert.ok(!JSON.stringify(compact.details.replacementHistory).includes("[PI_KB:"));
  phase="after-compact";
  await prompt("合言葉と、SDPが人間の修正データをどう使うかを100字程度で答えてください。");
  close();
  session=await open(SessionManager.open(path));
  phase="resumed-after-compact";
  await prompt("SDPの正式な論文名を答えてください。");
  for(const p of ["initial","resumed-before-compact","compact"]) {
    const request=requests.find(r=>r.phase===p);
    assert.equal(request?.kbCount,1,p+": exactly one plaintext KB message");
    assert.ok(request.beforeIndex>=0&&request.beforeIndex<request.kbIndex,p+": inserted after existing conversation");
    assert.equal(request.markers,false);
  }
  for(const p of ["after-compact","resumed-after-compact"]) {
    const request=requests.find(r=>r.phase===p);
    assert.equal(request?.kbCount,0,p+": no resurrection");
    assert.equal(request?.markers,false);
    assert.ok(request?.blobs>0,p+": new compacted history present");
  }
  assert.ok(answers.find(a=>a.phase==="after-compact").answer.includes("青い灯台"));
  await writeFile(root+"/result-v3.json",JSON.stringify({pass:true,requests,answers,sessionFile:path},null,2),{mode:0o600});
  console.log(JSON.stringify({pass:true,requests}));
} finally {close();}
