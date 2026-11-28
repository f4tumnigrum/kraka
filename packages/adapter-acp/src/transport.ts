import {isAbsolute} from "node:path";
import type {AcpConnection,AcpTransport} from "./acp";
const maxLine = 16 * 1024 * 1024;
const stderrLimit = 64 * 1024;
export class AcpProtocolError extends Error {}
export class AcpExit extends Error {
  constructor(readonly code:number|null,readonly signal:string|null){super("ACP process exited");}
}
export async function* decodeAcpLines(source:AsyncIterable<Uint8Array>) {
  let parts:Uint8Array[]=[];
  let size=0;
  const decoder=new TextDecoder("utf-8",{fatal:true});
  for await(const chunk of source) {
    let start=0;
    while(start<chunk.length){
      const lf=chunk.indexOf(10,start);
      const end=lf<0?chunk.length:lf;
      size+=end-start;
      if(size>maxLine)throw new AcpProtocolError("ACP frame exceeds 16 MiB");
      if(end>start)parts.push(chunk.subarray(start,end));
      if(lf<0)break;
      let frame:unknown;
      try{frame=JSON.parse(decoder.decode(Buffer.concat(parts,size)));}
      catch{throw new AcpProtocolError("Invalid ACP UTF-8 or JSON");}
      yield frame;
      size=0;parts=[];start=lf+1;
    }
  }
  if(size)throw new AcpProtocolError("Partial final ACP frame");
}
export async function deadline<T>(work:Promise<T>,ms:number,message:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
  finally{clearTimeout(timer);}
}
const ok=<T>(value:T)=>({kind:"ok",value} as const);
const closed=()=>({kind:"rejected",reason:"alreadyClosed",message:null} as const);
export function createAcpTransport():AcpTransport<AcpConnection>{
  const spawn=(command:string,args:readonly string[],cwd:string,env:Readonly<Record<string,string>>)=>Bun.spawn([command,...args],{cwd,env:{...env},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  type Process={child:ReturnType<typeof spawn>; closing:Promise<void>|null; stderr:Promise<void>; diagnostics:Buffer; reading:boolean};
  const processes=new WeakMap<AcpConnection,Process>();
  return {
    async open(spec){
      if(!isAbsolute(spec.workingDirectory)||!spec.command)return {kind:"rejected",reason:"invalidState",message:"ACP requires an executable and an absolute working directory"};
      try{
        const child=spawn(spec.command,spec.args,spec.workingDirectory,spec.environment);
        const connection={connection:{}};
        const process:Process={child,closing:null,stderr:Promise.resolve(),diagnostics:Buffer.alloc(0),reading:false};
        // Arbitrary executor stderr may contain credentials. Retain only its redacted line boundaries.
        process.stderr=(async()=>{for await(const chunk of child.stderr){
          const safe=Buffer.from(chunk.subarray(-stderrLimit));
          for(let i=0;i<safe.length;i++)if(safe[i]!==10 && safe[i]!==13)safe[i]=42;
          process.diagnostics=Buffer.concat([process.diagnostics,safe]).subarray(-stderrLimit);
        }})().catch(()=>{});
        processes.set(connection,process);
        return ok(connection);
      }catch{return {kind:"rejected",reason:"notFound",message:"Cannot launch the configured ACP executable"};}
    },
    async send(connection,frame){
      const p=processes.get(connection);
      if(!p||p.closing)return closed();
      const json=JSON.stringify(frame);
      if(typeof json!=="string"||Buffer.byteLength(json)>maxLine)return {kind:"rejected",reason:"unsupported",message:"ACP frame exceeds 16 MiB; use a resource reference"};
      try{
        p.child.stdin.write(json+"\n");
        await deadline(Promise.resolve(p.child.stdin.flush()),10000,"ACP frame write timed out");
        return ok(undefined);
      }catch{return {kind:"rejected",reason:"unsafeToRetry",message:"ACP write could not be confirmed"};}
    },
    async *frames(connection,after){
      const p=processes.get(connection);
      if(!p||p.reading||after!==null)throw new Error("ACP live reader unavailable");
      p.reading=true;
      let position=0;
      for await(const frame of decodeAcpLines(p.child.stdout))yield {cursor:String(++position),frame};
      if(!p.closing && (p.child.exitCode!==null||p.child.signalCode!==null))throw new AcpExit(p.child.exitCode,p.child.signalCode===null?null:String(p.child.signalCode));
    },
    async close(connection){
      const p=processes.get(connection);
      if(!p)return closed();
      p.closing??=(async()=>{
        const ended=Promise.all([p.child.exited,p.stderr]);
        try{void Promise.resolve(p.child.stdin.end()).catch(()=>{});await deadline(ended,2000,"ACP shutdown timed out");}
        catch{if(p.child.exitCode===null && p.child.signalCode===null)p.child.kill("SIGKILL");await deadline(ended,2000,"ACP child did not exit");}
      })();
      try{await p.closing;return ok(undefined);}
      catch{return {kind:"rejected",reason:"operationRejected",message:"Unable to reap ACP child"};}
      finally{processes.delete(connection);}
    }
  };
}
