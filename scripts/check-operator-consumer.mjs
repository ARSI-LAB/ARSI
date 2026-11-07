import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the packaged search loop with explicitly supplied retrieval resources. */
export async function checkOperatorConsumer(consumer, example) {
  const file = join(consumer, 'operator-search-consumer.mjs');
  await writeFile(
    file,
    `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createRuntime, agentContract } from 'ember-rsi';
const require=createRequire(import.meta.resolve('ember-rsi'));
const {parse,stringify}=require('yaml');
const example=${JSON.stringify(example)};
process.env.EVALUATOR_NETWORK_CONFIG=join(example,'network.yaml');
await writeFile(process.env.EVALUATOR_NETWORK_CONFIG,'{}\\n');
const source=marker=>'# '+marker+'\\ndef kernel_function(x):\\n    for i in range(2):\\n        y = x + 1\\n    return y\\n';
await writeFile(join(example,'baseline/input.py'),source('fixture:latency=10'));
const modelDirectory=join(example,'model');await mkdir(modelDirectory);
const bytes=Buffer.from('{}\\n');await writeFile(join(modelDirectory,'config.json'),bytes);
const identityFile=join(example,'embedding-identity.json');
await writeFile(identityFile,JSON.stringify({schemaVersion:'rsi.operator-embedding-identity/v1',model:{id:'test-model',revision:'test-revision'},encoding:{queryPromptName:'query',normalizeEmbeddings:true,device:'cpu',batchSize:32},files:[{path:'config.json',sha256:createHash('sha256').update(bytes).digest('hex')}]}));
const embeddingPython=join(example,'embedding-worker.mjs');
await writeFile(embeddingPython,'#!'+process.execPath+'\\n'+\`import {readFile,writeFile} from 'node:fs/promises';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const request=JSON.parse(await readFile(arg('--request'),'utf8'));const identity=JSON.parse(await readFile(request.identityFile,'utf8'));
await writeFile(arg('--response'),JSON.stringify({schemaVersion:'rsi.operator-retrieval/v1',embeddingDigest:request.embeddingDigest,resourcesDigest:request.resourcesDigest,matches:[],knowledgeContext:'',omitted:{techniques:[],examples:[]},model:identity.model,runtime:{python:'TEST-FIXTURE',sentenceTransformers:'TEST-FIXTURE',transformers:'TEST-FIXTURE',torch:'TEST-FIXTURE'}}));\`);
await chmod(embeddingPython,0o755);
const resourcesDirectory=join(example,'external-knowledge');await mkdir(join(resourcesDirectory,'knowledge'),{recursive:true});
await writeFile(join(resourcesDirectory,'knowledge/manifest.json'),JSON.stringify({schemaVersion:'rsi.operator-knowledge/v1',techniques:[],metrics:[],resources:[]}));
const recipe=parse(await readFile(join(example,'recipe.search.yaml'),'utf8'));
const examplePromptsDirectory=recipe.bindings.proposer.config.promptsDirectory;
assert.equal(typeof examplePromptsDirectory,'string','the example explicitly selects its local prompts');
const evaluator=recipe.bindings.evaluator.config;
evaluator.benchmark.config.python=join(example,'sdk-fixture-worker.mjs');
evaluator.benchmark.config.timeoutSeconds=15;
evaluator.run.timeoutSeconds=45;
recipe.policy={id:'policy.operator-search',config:{goal:'Installed functional fixture',caseIds:['fixed'],maxAttempts:1,repairLimit:0,metricsEnabled:false}};
recipe.bindings.agent={plugin:'agent.installed-operator-fixture',config:{}};
recipe.bindings.proposer={plugin:'proposer.operator',config:{agentRef:'agent',task:{directory:join(example,'task')},embedding:{python:embeddingPython,modelDirectory,identityFile,resourcesDirectory,retrievalScript:embeddingPython}}};
recipe.budget={operations:256,evaluationRuns:14,modelCalls:32,elapsedWallMs:2400000,cleanupReserveMs:60000};
const path=join(example,'recipe.search.fixture.yaml');await writeFile(path,stringify(recipe));
const runtime=await createRuntime({rootDirectory:join(example,'search-workspace')});const stages=[];
const promptStages=['diagnose','generate','summarize'];
const readPrompts=async directory=>Object.fromEntries(await Promise.all(promptStages.map(async stage=>[stage,await readFile(join(directory,stage+'.md'),'utf8')])));
let expectedPrompts;
runtime.registry.registerOperation({id:'agent.installed-operator-fixture',contract:agentContract,configSchema:{type:'object'},async create(){return{async execute(request,context){await context.charge('modelCalls',1);const stage=request.input.stage;stages.push(stage);
assert.ok(request.prompt.startsWith(expectedPrompts[stage]),'the selected prompt reaches the Agent');
if(stage==='diagnose')return{issues:[{issue_type:'loop_invariant_hoisting',issue_summary:'Invariant expression inside loop',problematic_code:['        y = x + 1'],evidence:['x does not change in the loop']}]};
if(stage==='summarize')return{explanation:'Synthetic measured result',lessons:[],avoidPatterns:[],tryPatterns:[]};
return{edits:[{path:'input.py',content:source('fixture:latency=8')}],reason:'Installed fixture change'};
},async dispose(){}};}});
try{
expectedPrompts=await readPrompts(join(dirname(runtime.registry.policy('policy.operator-search')),'prompts'));
const examplePrompts=await readPrompts(resolve(example,examplePromptsDirectory));
assert.notEqual(expectedPrompts.generate,examplePrompts.generate,'the packaged default and Ascend example supply distinct generation guidance');
const result=await runtime.manager.run(path,{id:'installed-static-search'});
assert.equal(result.status,'succeeded');assert.equal(result.output.stopReason,'accepted');assert.equal(result.output.finalValidity,'valid');assert.equal(result.output.finalTimingStable,true);
assert.equal(result.usage.evaluationRuns,3);assert.deepEqual(stages,['diagnose','generate','summarize']);
const calls=await runtime.manager.facts.list('calls');await runtime.manager.run(path,{id:result.id,resume:true});assert.deepEqual(await runtime.manager.facts.list('calls'),calls);
assert.ok((await runtime.manager.facts.list('instances')).every(i=>i.status==='released'));
recipe.bindings.proposer.config.promptsDirectory=examplePromptsDirectory;
await writeFile(path,stringify(recipe));expectedPrompts=examplePrompts;stages.length=0;
const configured=await runtime.manager.run(path,{id:'installed-ascend-search'});
assert.equal(configured.status,'succeeded');assert.equal(configured.output.finalValidity,'valid');
assert.equal(configured.usage.evaluationRuns,3);assert.deepEqual(stages,promptStages);
assert.ok((await runtime.manager.facts.list('instances')).every(i=>i.status==='released'));
console.log('Installed operator Proposer: packaged defaults and explicit example prompts reach the Agent; SDK search, final assessment, cleanup and completed resume passed.');
}finally{await runtime.dispose();}
`,
  );
  execFileSync(process.execPath, [file], {
    cwd: consumer,
    stdio: 'inherit',
    timeout: 60000,
  });
}
