import * as v from "valibot";
import {CAPABILITY_IDS,CapabilityMatrixSchema,type CapabilityId} from "@kraka/protocol";
import type {CapabilityDeclaration} from "@kraka/environment";
export function acpCapabilities(checkedAt:number,available=true,version=1):CapabilityDeclaration<"acp">{
  const native=new Set<CapabilityId>(["startSession","submitTextInput","streamResponse","exposeReasoning","reportToolActivity","reportRoundEnd","stopRound","requestCommandApproval","requestFileApproval","answerApprovalChoices","classifyErrors","declareTransport","negotiateProtocol","configureWorkspace","configureEnvironment"]);
  const unsupported={kind:"unsupported",reason:"The negotiated ACP peer provides no verified method for this operation."} as const;
  const matrix=v.parse(CapabilityMatrixSchema,Object.fromEntries(CAPABILITY_IDS.map(k=>[k,!available?unsupported:native.has(k)?{kind:"native"}:k==="selectPermissionMode"?{kind:"substitute",reason:"The adapter enforces ask on delegated permission requests."}:unsupported])));
  const ready={state:available?"yes" as const:"no" as const,verifiedAt:checkedAt};
  const none={receipt:"none",deduplicate:"none",query:"none"} as const;
  const steering={support:unsupported,readReceipt:"no",accepts:[]} as const;
  return {family:"acp",version,checkedAt,readiness:{configured:ready,installed:ready,authenticated:{state:"unknown",verifiedAt:null},model:{state:"unknown",verifiedAt:null},operation:ready},matrix,
    input:{...none,receipt:"proof"},answer:none,steering:{queueNext:steering,insertCurrent:steering,restartCurrent:steering},
    requests:{approval:{afterSessionLoss:"liveOnly"},question:{afterSessionLoss:"notResumable"}},
    permission:{modes:available?["ask"]:[],enforcement:"adapter",changeEffective:"nextTool"},endReasons:["completed","stopped","failed","unknown"],childWork:"unsupported"};
}
