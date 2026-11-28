import {createInterface} from "node:readline";
import * as v from "valibot";
import basic from "../../fixtures/executors/acp/basic-turn.jsonl" with {type:"text"};
import approval from "../../fixtures/executors/acp/command-approval.jsonl" with {type:"text"};
import {parseExecutorSample} from "../../packages/adapter-replay/src/recording";
const [control,scenario]=process.argv.slice(2);
if(!control||!scenario||new URL(control).hostname!=="127.0.0.1")throw Error("Expected loopback test controller and scenario");
const peer=crypto.randomUUID();
const sample=parseExecutorSample(scenario==="permission"?approval:basic);
if(sample.header.sourceRevision!=="d3ac0e6"||sample.header.family!=="acp")throw Error("Wrong ACP fixture revision");
const frames=sample.frames;
function frame(index:number){
  const value=frames[index-1]?.frame;
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Missing ACP fixture frame");
  return value;
}
const sessionId=v.parse(v.object({result:v.object({sessionId:v.string()})}),frame(4)).result.sessionId;
async function event(kind:string,key:string|number,wire?:unknown){
  const response=await fetch(control??"",{method:"POST",body:JSON.stringify({peer,sessionId,kind,key,wire})});
  if(!response.ok)throw Error("Test controller closed");
}
const write=(value:unknown)=>new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+"\n",error=>error?reject(error):resolve()));
const selected=Promise.withResolvers<void>();
const tasks:Promise<void>[]=[];
const schema=v.object({id:v.optional(v.union([v.number(),v.string()])),method:v.optional(v.string()),params:v.optional(v.unknown()),result:v.optional(v.unknown())});
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  const raw=JSON.parse(line);
  const request=v.parse(schema,raw);
  const key=request.id??"notification";
  await event(request.method??"reply",key,raw);
  if(request.method==="initialize"){
    if(!Bun.deepEquals(raw,frame(1)))throw Error("Unexpected initialize");
    await write(frame(2));
  }else if(request.method==="session/new"){
    const p=v.parse(v.object({cwd:v.string(),mcpServers:v.array(v.unknown())}),request.params);
    if(p.cwd!==process.cwd()||p.mcpServers.length||key!==2)throw Error("Wrong session setup");
    await write(frame(4));
  }else if(request.method==="session/prompt"){
    if(!Bun.deepEquals(raw,frame(5)))throw Error("Unexpected prompt");
    const run=async()=>{
      if(scenario==="authentication"){
        await write({jsonrpc:"2.0",id:key,error:{code:-32000,message:"private-fixture-marker-"+peer,data:{marker:"private-fixture-marker-"+peer}}});return;
      }
      if(scenario==="permission"){
        await write(frame(6));await write(frame(7));await event("permissionIssued",91);
      }
      await event("terminalHeld",key);
      if(scenario==="permission")await selected.promise;
      const first=scenario==="permission"?9:6;
      for(let i=first;i<=12;i++)await write(frame(i));
    };
    tasks.push(run());void tasks.at(-1)?.catch(()=>{});
  }else if(request.id===91&&request.result){
    if(!Bun.deepEquals(raw,frame(8)))throw Error("Wrong permission option or typed ID");
    selected.resolve();
  }
}
selected.resolve();
await Promise.allSettled(tasks);
await event("eof","eof");
