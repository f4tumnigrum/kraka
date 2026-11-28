import {bindExecutorAdapter,type ExecutorFamily,type FamilyProbe} from "@kraka/environment";
import {canonicalJson} from "@kraka/protocol";
import {AcpDuplex} from "./rpc";
import {createAcpTransport} from "./transport";
import {createAcpAdapter,initializeAcp} from "./adapter";
import {acpCapabilities} from "./capabilities";
export const acpFamily:ExecutorFamily={
  family:"acp",supports:r=>!!r.driver.executable&&r.driver.endpoint===null&&r.driver.configurationRoot===null&&r.driver.historyRoot===null,
  async probe(reg,cwd,environment) {
    const command=reg.driver.executable;
    if(!command)throw Error("Missing ACP executable");
    const launch={command,args:reg.driver.args??[],workingDirectory:cwd,environment};
    const instance={family:"acp" as const,instanceId:reg.instanceId};
    async function discover(previous?:FamilyProbe):Promise<FamilyProbe>{
      const transport=createAcpTransport();
      const opened=await transport.open(launch);
      let available=false,version:string|null=null;
      if(opened.kind==="ok"){
        const rpc=new AcpDuplex(transport,opened.value);
        try{const peer=await initializeAcp(rpc);available=true;version=peer.agentInfo?.version??null;}
        catch { /* An incompatible peer cannot accept a session. */ }
        finally{await rpc.close();}
      }
      const declaration=acpCapabilities(Date.now(),available,previous?.declaration.version??1);
      if(previous&&!Bun.deepEquals(previous.declaration.matrix,declaration.matrix))declaration.version++;
      const probe:FamilyProbe={declaration,binaryVersion:version,models:null,compatibilityAdvisory:available?null:"unsupported",versionAdvisory:null,retryAt:Date.now()+60000,
        bindingContext:canonicalJson([reg.instanceId,reg.credential,reg.version,cwd]),
        selectModel:model=>available && (!model || (model.id==="default"&&!Object.keys(model.options).length))?{id:"default",options:{}}:null,
        driver:previousEpoch=>bindExecutorAdapter(instance,createAcpAdapter(transport,{launch,instance,previousEpoch,declaration}),h=>({requestOpen:h.available})),
        refresh:()=>discover(probe)
      };return probe;
    }
    return discover();
  }
};
