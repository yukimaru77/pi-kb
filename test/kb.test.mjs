import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGE, validateSnapshot, expandInsertions, parseCommand } from "../core.mjs";
import { attachCompactionAdapter } from "../compaction-adapter.mjs";

const snapshot = {version:1, name:"example", items:[
  {type:"compaction", encrypted_content:"opaque-1", extra:{preserve:true}},
  {type:"compaction", encrypted_content:"opaque-2"},
  {type:"message",role:"developer",content:[{type:"input_text",text:"dev.txt"}]}
]};
const entry = (marker, value=snapshot) => ({type:"custom_message",customType:MESSAGE,content:marker,details:{snapshot:value}});
const message = text => ({role:"user",content:[{type:"input_text",text}]});

test("expands once at the insertion position, keeps developer role and opaque fields", () => {
  const payload={input:[message("before"),message("anchor"),message("after")],instructions:"system"};
  const original=structuredClone(payload);
  const result=expandInsertions(payload,[entry("anchor")]);
  assert.deepEqual(result.input,[payload.input[0],...snapshot.items,payload.input[2]]);
  assert.deepEqual(payload,original);
  assert.equal(expandInsertions(result,[entry("anchor")]),result);
  result.input[1].extra.preserve=false;
  assert.equal(snapshot.items[0].extra.preserve,true);
});

test("compaction removes anchor permanently; historical records cannot resurrect knowledge", () => {
  const payload={input:[{type:"compaction",encrypted_content:"new-combined-history"},message("after")]};
  assert.equal(expandInsertions(payload,[entry("anchor")]),payload);
  const kept={input:[message("anchor"),message("recent")]};
  assert.equal(expandInsertions(kept,[]),kept);
  assert.equal(expandInsertions(kept,[entry("anchor")]).input.length,4);
});

test("multiple insertions retain order and branch-local content", () => {
  const second={...snapshot,name:"second",items:[{type:"compaction",encrypted_content:"second-blob"}]};
  const payload={input:[message("a"),message("middle"),message("b")]};
  assert.deepEqual(expandInsertions(payload,[entry("a"),entry("b",second)]).input,
    [...snapshot.items,message("middle"),...second.items]);
  assert.deepEqual(expandInsertions(payload,[entry("a")]).input.at(-1),message("b"));
});

test("compact adapter expands before compact captures input; restores original provider API", async () => {
  let captured;
  const provider={stream:async (_m,_c,opts)=>opts.onPayload({input:[message("before"),message("anchor")]})};
  const runtime={getProvider:()=>provider};
  const original=runtime.getProvider;
  const detach=attachCompactionAdapter(runtime,()=>[entry("anchor")]);
  const result=await runtime.getProvider("openai-codex").stream({api:"openai-codex-responses"},{},{
    onPayload:(payload)=>{captured=structuredClone(payload);return {...payload,input:[...payload.input,{type:"compaction_trigger"}]};}
  });
  assert.deepEqual(captured.input,[message("before"),...snapshot.items]);
  assert.equal(result.input.at(-1).type,"compaction_trigger");
  detach();
  assert.equal(runtime.getProvider,original);
  assert.equal(runtime.getProvider(),provider);
});

test("validates data and arguments", () => {
  assert.throws(()=>validateSnapshot({...snapshot,items:[{type:"compaction",encrypted_content:""}]}));
  assert.deepEqual(parseCommand("pi --store research --file v1"),{action:"load",argv:["export","pi","--store","research","--file","v1"]});
  assert.throws(()=>parseCommand("x;uname"));
  assert.throws(()=>parseCommand("pi --file"));
});

test("reusing SDK runtime retires the old session adapter even without shutdown", async () => {
  const provider={stream:(_m,_c,o)=>o.onPayload({input:[message("anchor")]})};
  const runtime={getProvider:()=>provider};
  const original=runtime.getProvider;
  const old=attachCompactionAdapter(runtime,()=>{throw new Error("stale session");});
  const fresh=attachCompactionAdapter(runtime,()=>[entry("anchor")]);
  old(); // late cleanup must not tear down the new owner
  const result=await runtime.getProvider().stream({api:"openai-codex-responses"},{},{});
  assert.deepEqual(result.input,snapshot.items);
  fresh();
  assert.equal(runtime.getProvider,original);
});
