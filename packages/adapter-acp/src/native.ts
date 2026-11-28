import * as v from "valibot";
import {NativeSessionIdSchema,NativeItemIdSchema,NativeRequestIdSchema} from "@kraka/protocol";
import type {AdapterEventPayload,ApprovalAuthority} from "@kraka/environment";
import type {RpcId} from "./rpc";
import {AcpProtocolError} from "./transport";
const text = v.pipe(v.string(),v.nonEmpty());
const object=v.object({});
const capabilities=v.object({
  loadSession:v.optional(v.boolean(),false),
  sessionCapabilities:v.optional(v.object({resume:v.optional(object)})),
  promptCapabilities:v.optional(v.object({image:v.optional(v.boolean(),false)})),
});
export const initialized=v.object({protocolVersion:v.literal(1),agentCapabilities:capabilities,agentInfo:v.optional(v.object({name:text,version:text})),authMethods:v.optional(v.array(v.object({id:text})),[])});
export const newSession=v.object({sessionId:NativeSessionIdSchema});
export const terminal=v.object({stopReason:text});
export const authMessage="Sign in through the executor settings, CLI or application, then retry.";
const option=v.object({optionId:v.pipe(text,v.maxLength(256)),kind:text,name:text});
const permission=v.object({sessionId:NativeSessionIdSchema,toolCall:v.object({toolCallId:NativeItemIdSchema,kind:text}),options:v.array(option)});
const update=v.object({sessionId:NativeSessionIdSchema,update:v.objectWithRest({sessionUpdate:text},v.unknown())});
const chunk=v.object({content:v.object({type:v.literal("text"),text:v.string()}),messageId:v.optional(NativeItemIdSchema)});
const tool=v.object({toolCallId:NativeItemIdSchema,status:v.picklist(["pending","in_progress","completed","failed"]),title:v.optional(v.string()),content:v.optional(v.array(v.unknown()))});
export function validated<S extends v.GenericSchema>(schema:S,raw:unknown):v.InferOutput<S>{
  const result=v.safeParse(schema,raw);
  if(!result.success)throw new AcpProtocolError("Invalid ACP response");
  return result.output;
}
export function reversePermission(raw:unknown,id:RpcId){
  const p=validated(permission,raw);
  if(new Set(p.options.map(o=>o.optionId)).size!==p.options.length)throw new AcpProtocolError("Duplicate permission option");
  const choices:ApprovalAuthority["choices"]=p.options.flatMap(o=>o.kind==="allow_once"||o.kind==="reject_once"?[{kind:"approval",choiceKey:o.optionId,decision:o.kind==="allow_once"?"allow":"deny",scope:"once"}]:[]);
  const file=p.toolCall.kind==="edit"||p.toolCall.kind==="delete"||p.toolCall.kind==="move";
  if(!choices.length || (!file && p.toolCall.kind!=="execute"))return null;
  const requestId=v.parse(NativeRequestIdSchema,JSON.stringify(["in",id]));
  const payload:Omit<Extract<AdapterEventPayload,{kind:"requestOpened"}>,"attemptId">={kind:"requestOpened",requestId,nativeNode:p.toolCall.toolCallId,recovery:"liveOnly",
    body:{kind:"approval",tool:file?"file":"command",choices:choices.map(c=>({key:c.choiceKey,allowsEdit:false,scope:c.scope}))},
    approval:{permission:file?"workspace.change":"term.input",choices}};
  return {sessionId:p.sessionId,id,requestId,choices,payload};
}
export function sessionUpdate(raw:unknown) {
  const p=validated(update,raw);
  const u=p.update;
  switch(u.sessionUpdate){
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const decoded=v.safeParse(chunk,u);
      if(!decoded.success)return null;
      return {kind:"content" as const,sessionId:p.sessionId,role:u.sessionUpdate==="agent_message_chunk"?"assistant" as const:"reasoning" as const,text:decoded.output.content.text,itemId:decoded.output.messageId};
    }
    case "tool_call":
    case "tool_call_update":{
      const data=validated(tool,u);
      const phase=data.status==="pending"?"started" as const:data.status==="in_progress"?"progress" as const:"ended" as const;
      const outputs=data.content?.flatMap(item=>{const decoded=v.safeParse(v.object({type:v.literal("content"),content:v.object({type:v.literal("text"),text:v.string()})}),item);return decoded.success?[decoded.output.content.text]:[];});
      return {kind:"tool" as const,sessionId:p.sessionId,callId:data.toolCallId,phase,input: data.title?{command:data.title}:null,output:outputs?.join("")??null};
    }
    default:return null;
  }
}
