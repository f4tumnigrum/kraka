import * as v from "valibot";
import type {AcpConnection,AcpTransport} from "./acp";
import {AcpProtocolError} from "./transport";
const idSchema=v.union([v.pipe(v.number(),v.safeInteger()),v.string()]);
export type RpcId=v.InferOutput<typeof idSchema>;
const base={jsonrpc:v.literal("2.0")};
const rpc=v.union([
  v.strictObject({...base,method:v.pipe(v.string(),v.nonEmpty()),params:v.optional(v.unknown()),id:v.optional(idSchema)}),
  v.strictObject({...base,id:idSchema,result:v.nonOptional(v.unknown())}),
  v.strictObject({...base,id:idSchema,error:v.object({code:v.pipe(v.number(),v.integer()),message:v.string(),data:v.optional(v.unknown())})})
]);
export type Reply={id:RpcId;result:unknown;cursor:string}|{id:RpcId;code:number;cursor:string};
export type Call={id:RpcId;method:string;params:unknown;cursor:string};
type Pending={method:string;finish:(r:Reply)=>void;fail:(error:Error)=>void;timer:ReturnType<typeof setTimeout>|undefined};
export class AcpDuplex {
  private next=1;
  private readonly pending=new Map<RpcId,Pending>();
  private readonly incoming=new Set<RpcId>();
  private lost:Error|null=null;
  readonly reader:Promise<void>;
  onCall:(call:Call)=>boolean=()=>false;
  onNotice:(method:string,params:unknown,cursor:string)=>void=()=>{};
  onLost:(error:Error)=>void=()=>{};
  constructor(readonly transport:AcpTransport<AcpConnection>,readonly connection:AcpConnection){
    this.reader=this.read().then(()=>this.fail(new Error("ACP stdout closed")),e=>this.fail(e instanceof Error?e:new Error("ACP transport failed")));
  }
  private fail(error:Error){
    if(this.lost)return;
    this.lost=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.fail(error);}
    this.pending.clear();this.incoming.clear();this.onLost(error);
  }
  private async read(){
    for await(const entry of this.transport.frames(this.connection,null)){
      const decoded=v.safeParse(rpc,entry.frame);
      if(!decoded.success||entry.cursor===null)throw new AcpProtocolError("Invalid ACP RPC envelope");
      const f=decoded.output,cursor=entry.cursor;
      if("method" in f){
        if(f.id===undefined)this.onNotice(f.method,f.params,cursor);
        else{
          if(this.incoming.has(f.id))throw new AcpProtocolError("Duplicate reverse ACP request");
          this.incoming.add(f.id);
          if(!this.onCall({id:f.id,method:f.method,params:f.params,cursor}))await this.reply(f.id,{error:{code:-32601,message:"Method not supported"}});
        }
      }else{
        const p=this.pending.get(f.id);
        if(!p)continue;
        const result:Reply="error" in f?{id:f.id,code:f.error.code,cursor}:{id:f.id,result:f.result,cursor};
        p.finish(result);
        clearTimeout(p.timer);this.pending.delete(f.id);
      }
    }
  }
  async send(frame:object){
    if(this.lost)throw this.lost;
    const written=await this.transport.send(this.connection,{jsonrpc:"2.0",...frame});
    if(written.kind!=="ok")throw Error(written.message??"ACP write failed");
  }
  request(method:string,params:object,options:{id?:RpcId;onReply?:(r:Reply)=>void;prepare?:(id:RpcId)=>void}={}){
    const id=options.id??this.next++;
    if(this.lost)throw this.lost;
    if(this.pending.has(id))throw Error("Duplicate outgoing ACP request");
    const done=Promise.withResolvers<Reply>();
    const p:Pending={method,finish:r=>{options.onReply?.(r);done.resolve(r);},fail:done.reject,timer:undefined};
    options.prepare?.(id);
    this.pending.set(id,p);
    if(method!=="session/prompt")this.refreshDeadline(id);
    const written=this.send({method,id,params});
    void written.catch(e=>this.fail(e));
    void done.promise.catch(()=>{});
    return {id,written,reply:done.promise};
  }
  refreshDeadline(id:RpcId){
    const p=this.pending.get(id);
    if(!p)return;
    clearTimeout(p.timer);
    p.timer=setTimeout(()=>this.fail(Error("ACP request timed out")),10000);
  }
  async reply(id:RpcId,body:{result:object}|{error:{code:number;message:string}}){
    if(!this.incoming.delete(id))throw Error("Expired ACP reverse request");
    await this.send({id,...body});
  }
  async close(){
    this.fail(Error("ACP connection closed"));
    const result=await this.transport.close(this.connection);
    return result;
  }
}
