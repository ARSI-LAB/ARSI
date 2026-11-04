import { execFileSync } from 'node:child_process';

/** Exercise the installed SDKs together without a model, Docker, or a Harness. */
export function checkSdkConsumer(
  packageDirectory,
  bundleDirectory,
  isolated = false,
) {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBundleSdk} from 'agent-bundle-core';
import {Evaluator} from 'ember-evaluator';
import {RuntimeContext} from './dist/src/contracts/index.js';
import {FileArtifacts} from './dist/src/runtime/storage/index.js';
import {createAgentbench} from './dist/src/plugins/evaluator-agentbench/service.js';
if(${JSON.stringify(isolated)}){
 const installed=await realpath(${JSON.stringify(packageDirectory)});
 for(const name of ['agent-bundle-core','ember-evaluator']){
  const entry=await realpath(fileURLToPath(import.meta.resolve(name)));
  assert.ok(entry.startsWith(installed+sep),name+' must be bundled inside the installed RSI package');
 }
}
const bundle=${JSON.stringify(bundleDirectory)};
const verified=await createBundleSdk().verify(bundle);
assert.equal(verified.manifest.kind,'dsh-agent-bundle');
const root=await mkdtemp(join(tmpdir(),'rsi-sdk-consumer-'));
process.env.EVALUATOR_RUN_INDEX_DIR=join(root,'run-index');
try {
 const plugin=\`
import {appendFileSync} from 'node:fs';
import {createBundleSdk} from \${JSON.stringify(import.meta.resolve('agent-bundle-core'))};
export const inject=['evaluator'];
export function apply(ctx){
 ctx.effect(()=>()=>appendFileSync(new URL('./disposed',import.meta.url),'done,'));
 ctx.evaluator.register('benchmark','bundle-smoke',value=>value,config=>({
  async resolveSource(){return {source:'bundle-smoke',revision:'1',files:[],metadata:{}};},
  async *enumerate(){yield {id:'bundle',recordKey:0};},
  async prepare(){return {input:{id:'bundle',prompt:'Verify the bundle'},verification:null,
   solveEnv:{workdir:'.',image:null,initialFiles:[],runtime:[]},verifyEnv:null,transfer:null};},
  async verify(_task,result){const passed=result.finalText===config.digest;return {score:Number(passed),passed,details:{}};}
 }));
 ctx.evaluator.register('solver','bundle-smoke',value=>value,config=>({
  requirements(){return [];},
  async solve(){
   appendFileSync(new URL('./executions',import.meta.url),'run,');
   const result=await createBundleSdk().verify(config.path);
   return {finalText:result.digest,usage:{inputTokens:null,outputTokens:null,totalTokens:null}};
  }
 }));
}
\`;
 await writeFile(join(root,'plugin.mjs'),plugin);
 const patchPath=join(root,'patch.yaml'),configPath=join(root,'config.yaml');
 await writeFile(patchPath,JSON.stringify([{insert:[{id:'bundle-smoke',name:'./plugin.mjs'}]}]));
 await writeFile(configPath,JSON.stringify({
  services:{default:{model:'fixture',base_url:'https://fixture.invalid',api_key:'$'+'{RSI_SDK_TEST_KEY}'}},
  benchmark:{name:'bundle-smoke',config:{digest:verified.digest},solver:{name:'bundle-smoke',config:{path:bundle}}},
  environment:'local',output:{directory:join(root,'results')}
 }));
 const sdk=new Evaluator(),options={configPath,patchPath,env:{RSI_SDK_TEST_KEY:'fixture-only'}};
 const result=await sdk.run(options);
 assert.equal(result.kind,'local');assert.equal(result.exitCode,0);
 assert.equal(result.snapshot.run.status,'completed');
 assert.equal(result.snapshot.records.length,1);
 assert.equal(result.snapshot.records[0].verdict.passed,true);
 assert.equal(result.snapshot.records[0].cleanupStatus,'cleaned');
 assert.ok((await readFile(result.reportPath,'utf8')).length);
 const resumed=await sdk.run({...options,resume:true});
 assert.equal(resumed.runId,result.runId);assert.equal(resumed.exitCode,0);
 assert.equal(await readFile(join(root,'executions'),'utf8'),'run,');
 assert.equal(await readFile(join(root,'disposed'),'utf8'),'done,done,');
 const artifacts=new FileArtifacts(join(root,'rsi-artifacts'));
 let measurement,charges=0;
 const context=new RuntimeContext().extend({
  directory:join(root,'adapter'),experimentId:'smoke',callId:'smoke',
  signal:new AbortController().signal,artifacts,
  async charge(metric,amount){assert.equal(metric,'evaluationRuns');charges+=amount;},
  async withInstance(candidate,capability,use){
   assert.equal(candidate,'candidate-smoke');assert.equal(capability,'agentbundle');
   return use({directory:bundle,bundleDigest:verified.digest});
  },
  async recordMeasurement(value){measurement=value;return value.ref;}
 });
 const config=JSON.parse(await readFile(configPath,'utf8'));delete config.output;
 config.benchmark.solver={name:'agentbundle',config:{}};
 const adapter=await createAgentbench(config,context,async options=>{
  const native=JSON.parse(await readFile(options.configPath,'utf8'));
  assert.equal(native.benchmark.solver.name,'agentbundle');
  assert.equal(native.benchmark.solver.config.path,bundle);
  assert.deepEqual(native.run.taskIds,['bundle']);
  return result;
 });
 try{
  const output=await adapter.execute({candidateRef:'candidate-smoke',taskIds:['bundle']},context);
  assert.equal(output.measurementRef,'measurement-smoke');assert.equal(charges,1);
  assert.equal(measurement.status,'succeeded');assert.equal(measurement.coverage,'complete');
  assert.deepEqual(measurement.metrics.successRate.value,{kind:'scalar',value:1});
  const items=await artifacts.readJson(measurement.itemsRef);
  assert.equal(items.items[0].subject.id,'bundle');
  const evidence=await artifacts.readJson(measurement.evidenceIndexRef);
  assert.ok(evidence.entries.some(entry=>entry.kind==='native-result'));
 }finally{await adapter.dispose();}
 console.log('RSI adapter + Evaluator + AgentBundle: measurement, evidence, report, cleanup and resume passed.');
}finally{await rm(root,{recursive:true,force:true});}
`,
    ],
    { cwd: packageDirectory, stdio: 'inherit', timeout: 60000 },
  );
}
