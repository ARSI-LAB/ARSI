import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  readdir,
  cp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOperatorConsumer } from './check-operator-consumer.mjs';
import { checkSdkConsumer } from './check-sdk-consumer.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'rsi-package-')));
const networkConfigPath = join(temporary, 'network.yaml');
const consumerEnv = {
  ...process.env,
  EVALUATOR_NETWORK_CONFIG: networkConfigPath,
};
function run(args, cwd, stdio = 'inherit') {
  const executable = process.env.npm_execpath;
  assert.ok(
    executable || process.platform !== 'win32',
    'Run this check through pnpm check:package on Windows',
  );
  const nodeScript = executable && /\.[cm]?js$/i.test(executable);
  return execFileSync(
    nodeScript ? process.execPath : (executable ?? 'pnpm'),
    nodeScript ? [executable, ...args] : args,
    {
      cwd,
      stdio,
      env: consumerEnv,
      timeout: 600000,
      encoding: 'utf8',
    },
  );
}
try {
  await writeFile(networkConfigPath, '{}\n');
  run(['pack', '--pack-destination', temporary], root, [
    'ignore',
    'ignore',
    'inherit',
  ]);
  const archives = (await readdir(temporary)).filter((name) =>
    name.endsWith('.tgz'),
  );
  assert.equal(
    archives.length,
    1,
    'pack produces exactly one distributable archive',
  );
  const consumer = join(temporary, 'consumer');
  const outside = join(temporary, 'outside-source');
  await mkdir(consumer);
  await mkdir(outside);
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'rsi-package-consumer',
        private: true,
        type: 'module',
        packageManager: manifest.packageManager,
      },
      null,
      2,
    ) + '\n',
  );
  // A consumer has no source-checkout overrides or access to sibling repositories.
  await writeFile(
    join(consumer, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\n  protobufjs: false\n  '@google/genai': false\n",
  );
  run(['add', join(temporary, archives[0])], consumer);
  const command = join(
    consumer,
    'node_modules/ember-rsi/dist/src/entries/cli/main.js',
  );
  const help = execFileSync(process.execPath, [command, '--help'], {
    env: consumerEnv,
    cwd: outside,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(
    help,
    /run \[options\] <recipe.yaml>/,
    'installed executable works outside its source checkout',
  );
  assert.match(help, /reflection/);
  for (const args of [
    ['run', '--help'],
    ['run', '-h'],
    ['reflection', '-h'],
    ['reflection', 'apply', '-h'],
    ['reflection', 'apply', '--help'],
  ]) {
    const detail = execFileSync(process.execPath, [command, ...args], {
      env: consumerEnv,
      cwd: outside,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(
      detail,
      args[0] === 'run'
        ? /--resume/
        : args.length === 2
          ? /apply/
          : /<revisionID>/,
    );
  }
  const installedManifest = JSON.parse(
    await readFile(
      join(consumer, 'node_modules/ember-rsi/package.json'),
      'utf8',
    ),
  );
  assert.equal(installedManifest.name, 'ember-rsi');
  assert.deepEqual(installedManifest.bin, {
    'ember-rsi': './dist/src/entries/cli/main.js',
  });
  const installedBin = join(
    consumer,
    'node_modules/.bin',
    process.platform === 'win32' ? 'ember-rsi.cmd' : 'ember-rsi',
  );
  const binHelp = execFileSync(installedBin, ['--help'], {
    env: consumerEnv,
    cwd: outside,
    encoding: 'utf8',
    timeout: 30000,
    shell: process.platform === 'win32',
  });
  assert.match(binHelp, /list \[kind\]/);

  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, [command, 'reflection', 'list'], {
        env: consumerEnv,
        cwd: outside,
        encoding: 'utf8',
        timeout: 30000,
      }),
    ),
    [],
    'installed Reflection list works outside the source checkout',
  );
  for (const action of ['show', 'apply']) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [command, 'reflection', action, 'revision-missing'],
          {
            env: consumerEnv,
            cwd: outside,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 30000,
          },
        ),
      (error) =>
        /Unknown revision ID revision-missing/.test(String(error.stderr)),
      `installed Reflection ${action} resolves exact revision identities`,
    );
  }
  const extension = join(consumer, 'external-extension');
  await mkdir(extension);
  await writeFile(
    join(extension, 'index.mjs'),
    `import { defineContract } from 'ember-rsi';
import { fileURLToPath } from 'node:url';
export function register(registry) {
  registry.registerOperation({
    id: 'external.probe',
    contract: defineContract({ id: 'contract.external-probe', input_schema: { type: 'object' }, output_schema: { type: 'object' } }),
    configSchema: { type: 'object' },
    async create() { return { async execute(input) { return input; }, async dispose() {} }; },
  });
  registry.registerPolicy('external.policy', fileURLToPath(new URL('./policy.yaml', import.meta.url)));
}
`,
  );
  await writeFile(
    join(extension, 'policy.yaml'),
    'schemaVersion: rsi.policy/v1\nid: external.policy\ninput_schema: { type: object }\noutput_schema: { type: object }\nsteps: []\noutput: {}\n',
  );
  const externalCatalog = JSON.parse(
    execFileSync(
      process.execPath,
      [command, 'catalog', '--plugin-dir', extension],
      {
        env: consumerEnv,
        cwd: outside,
        encoding: 'utf8',
        timeout: 30000,
      },
    ),
  );
  assert.ok(externalCatalog.plugins.includes('external.probe'));
  assert.ok(externalCatalog.policies.includes('external.policy'));
  const catalog = JSON.parse(
    execFileSync(process.execPath, [command, 'catalog'], {
      env: consumerEnv,
      cwd: outside,
      encoding: 'utf8',
      timeout: 30000,
    }),
  );
  assert.equal(
    catalog.plugins.length,
    18,
    'all built-in plugin definitions ship in the archive',
  );
  for (const id of [
    'application.kernel',
    'evaluator.operatorbench',
    'selector.inference',
    'proposer.operator',
  ])
    assert.ok(catalog.plugins.includes(id), `${id} ships in the archive`);
  assert.ok(!catalog.plugins.includes('agent.scripted'));
  assert.ok(catalog.plugins.includes('agent.codex'));
  assert.ok(catalog.plugins.includes('proposer.pareto-evolution'));
  assert.deepEqual(
    [...catalog.policies].sort(),
    [
      'parameter.agent',
      'policy.gepa',
      'policy.harness2',
      'policy.operator-search',
      'policy.parameter-grid',
      'policy.parameter-optuna',
      'policy.wikiskill',
    ],
    'all built-in policies ship in the archive',
  );
  for (const name of ['dsh-harness2', 'dsh-wikiskill', 'dsh-gepa']) {
    const example = join(outside, name);
    await cp(join(root, 'examples/harness', name), example, {
      recursive: true,
    });
    const validation = JSON.parse(
      execFileSync(
        process.execPath,
        [command, 'validate', join(example, 'recipe.yaml')],
        {
          env: consumerEnv,
          cwd: outside,
          encoding: 'utf8',
          timeout: 30000,
        },
      ),
    );
    assert.equal(
      validation.valid,
      true,
      'installed package resolves example bindings and policy schemas',
    );
    if (name === 'dsh-harness2')
      assert.ok(
        validation.plugins.includes('reflection.agent'),
        'installed consumer assembles Reflection with its packaged default prompt',
      );
    if (name === 'dsh-gepa') {
      assert.equal(validation.policyId, 'policy.gepa');
      assert.ok(
        validation.plugins.includes('proposer.pareto-evolution'),
        'installed consumer assembles built-in GEPA without an extension directory',
      );
    }
  }
  checkSdkConsumer(
    join(consumer, 'node_modules/ember-rsi'),
    join(outside, 'dsh-harness2/baseline'),
    true,
  );
  for (const name of [
    'shared',
    'parameter-grid',
    'parameter-tpe',
    'parameter-agent',
  ]) {
    await cp(
      join(root, 'examples/artifacts/inference', name),
      join(outside, name),
      { recursive: true },
    );
  }
  for (const name of ['parameter-grid', 'parameter-tpe', 'parameter-agent']) {
    const inferenceValidation = JSON.parse(
      execFileSync(
        process.execPath,
        [command, 'validate', join(outside, name, 'recipe.yaml')],
        { env: consumerEnv, cwd: outside, encoding: 'utf8', timeout: 30000 },
      ),
    );
    assert.equal(
      inferenceValidation.valid,
      true,
      `installed package validates ${name} without source paths`,
    );
    if (name === 'parameter-agent') {
      assert.equal(inferenceValidation.policyId, 'parameter.agent');
      assert.ok(inferenceValidation.plugins.includes('selector.inference'));
      assert.ok(
        inferenceValidation.plugins.includes('evaluator.inferencebench'),
      );
    }
  }
  const packagedWorker = join(
    consumer,
    'node_modules/ember-rsi/dist/src/plugins/proposer-optuna/python/worker.py',
  );
  assert.ok((await readFile(packagedWorker, 'utf8')).includes('import optuna'));
  assert.match(
    await readFile(join(dirname(packagedWorker), 'requirements.txt'), 'utf8'),
    /optuna==4\.5\.0/,
  );
  if (process.env.RSI_OPTUNA_PYTHON) {
    const checked = JSON.parse(
      execFileSync(process.env.RSI_OPTUNA_PYTHON, [packagedWorker], {
        env: consumerEnv,
        cwd: outside,
        input: JSON.stringify({ action: 'check' }),
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.equal(checked.environment.optuna, '4.5.0');
    const sampled = JSON.parse(
      execFileSync(process.env.RSI_OPTUNA_PYTHON, [packagedWorker], {
        env: consumerEnv,
        cwd: outside,
        input: JSON.stringify({
          action: 'suggest',
          sampler: { type: 'random', seed: 42, options: {} },
          constraintHandling: 'selection-only',
          searchSpace: [{ name: 'x', distribution: 'int', low: 1, high: 3 }],
          history: [],
        }),
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.ok([1, 2, 3].includes(sampled.parameters.x));
  }
  const operatorExample = join(outside, 'transpose-copy');
  await cp(
    join(root, 'examples/artifacts/kernel/transpose-copy'),
    operatorExample,
    { recursive: true },
  );
  const sdkWorker = join(operatorExample, 'sdk-fixture-worker.mjs');
  await cp(join(root, 'tests/fixtures/operator-sdk/worker.mjs'), sdkWorker);
  const { chmod } = await import('node:fs/promises');
  await chmod(sdkWorker, 0o755);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import {readFile} from 'node:fs/promises';
       const sdk = await import('ember-evaluator');
       for (const name of ['Evaluator','parseUserConfig','parseKernelTimingEvidence','auditKernelTimingSample']) assert.equal(typeof sdk[name], 'function');
       const helper = await readFile(new URL('adapters/kernel/timing_evidence.py', import.meta.resolve('ember-evaluator')), 'utf8');
       assert.match(helper, /def collect_flow_timing/);`,
    ],
    {
      env: consumerEnv,
      cwd: join(consumer, 'node_modules/ember-rsi'),
      stdio: 'inherit',
      timeout: 30000,
    },
  );
  const previewFixtures = await Promise.all(
    ['paragraphs-and-table.docx', 'pages.pdf'].map(async (path) => ({
      path,
      mode: 420,
      base64: (
        await readFile(join(root, 'tests/fixtures/reflection', path))
      ).toString('base64'),
    })),
  );
  await writeFile(
    join(consumer, 'consume.mjs'),
    `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat,writeFile,mkdir} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createRuntime,Policy,Binding,proposerContract,operatorProposerContract,gridProposerContract,iterativeProposerContract,applicationContract,defineContract,RuntimeContext,prepareAgentProject} from 'ember-rsi';
import {RuntimeContext as ContractContext,iterativeProposerContract as ContractsIterativeProposerContract} from 'ember-rsi/contracts';
assert.equal(RuntimeContext,ContractContext);
assert.equal(iterativeProposerContract,ContractsIterativeProposerContract);
const packageDirectory=await realpath(${JSON.stringify(join(consumer, 'node_modules/ember-rsi'))});
async function packageResource(path){
 const location=relative(packageDirectory,await realpath(path));
 assert.ok(location!=='..'&&!location.startsWith('..'+sep)&&!isAbsolute(location),'built-in resource resolves within the installed package');
 return path;
}
const context=new RuntimeContext().extend({traceId:'consumer'});
const runtime=await createRuntime({rootDirectory:${JSON.stringify(outside)},context});
for(const [id,template] of [
 ['evaluator.agentbench',{benchmark:'gsm8k',services:{default:{model:'consumer',base_url:'https://consumer.invalid'}}}],
 ['evaluator.inferencebench',{benchmark:'agentx'}],
]){
 const definition=runtime.registry.get(id);
 const config={hardware:'gpu',...template};
 const bind=value=>Binding.resolve({name:'evaluator',registry:runtime.registry,required:definition.contract,override:{declaration:{plugin:id,config:value},directory:${JSON.stringify(outside)}}});
 const binding=bind(config);
 assert.deepEqual(binding.config,config,'installed bindings preserve native fields and instance templates');
 const operation=await definition.create(binding.config,context);
 await operation.dispose();
 await assert.rejects(async()=>{
  const invalid=await definition.create(bind({...config,unsupported:true}).config,context);
  try{
   await invalid.execute({candidateRef:'candidate:consumer',...(id==='evaluator.agentbench'?{taskIds:['task/a']}:{})},context.extend({
    directory:resolve(${JSON.stringify(outside)},'invalid-evaluator'),signal:new AbortController().signal,
    withInstance:async(_candidate,_capability,use)=>use({directory:resolve(${JSON.stringify(outside)},'candidate'),baseUrl:'http://127.0.0.1:8000/v1',model:'candidate'}),
    charge:async()=>{throw new Error('Invalid configuration reached evaluation budget');},
   }));
  }finally{await invalid.dispose();}
 },/configuration.*unsupported/,'installed evaluator delegates validation to its SDK before evaluation');
}
assert.equal(runtime.context.traceId,'consumer');
const standalonePolicy=new Policy({schemaVersion:'rsi.policy/v1',id:'consumer.policy',input_schema:{type:'object'},output_schema:{type:'object'},steps:[],output:{value:7}});
assert.deepEqual(await standalonePolicy.execute({application:{},context:context.extend({signal:new AbortController().signal}),invoke:async()=>{throw new Error('Unexpected plugin call');},checkpoint:async()=>{}}),{value:7},'installed Policy supports direct construction and execution');
try {
 const installed=new URL('./node_modules/ember-rsi/dist/src/',import.meta.url);
 const {validate}=await import(new URL('shared/schema.js',installed));
 assert.equal(operatorProposerContract.id,'contract.proposer-operator');
 const firstProposal={action:'propose',phase:'static',entryCandidateRef:'entry',baselineMeasurementRef:'baseline',attempt:1,goal:'Improve',analysisRef:null,historyRef:null};
 const repairProposal={action:'repair',phase:'static',failedCandidateRef:'failed',measurementRef:'measurement',analysisRef:'analysis',historyRef:null,attempt:1,repairIndex:1,goal:'Repair'};
 const attemptSummary={action:'summarize',phase:'static',entryCandidateRef:'entry',analysisRef:'analysis',historyRef:null,attempt:1,candidateRefs:['candidate'],measurementRefs:[],decisionRef:null,outcome:'no-change'};
 for(const action of [firstProposal,repairProposal,attemptSummary])validate(operatorProposerContract.input_schema,action,'installed operator action');
 assert.throws(()=>validate(operatorProposerContract.input_schema,{...firstProposal,action:'diagnose'}));
 assert.throws(()=>validate(operatorProposerContract.input_schema,{...firstProposal,baselineMeasurementRef:undefined}));
 const operatorDirectory=await realpath(fileURLToPath(new URL('plugins/proposer-operator/',installed)));
 for(const directory of ['knowledge','python','prompts'])await assert.rejects(stat(resolve(operatorDirectory,directory)),{code:'ENOENT'});
 assert.deepEqual(runtime.registry.get('proposer.operator').contract,operatorProposerContract);
 const {prepareDocumentPreviews}=await import(new URL('plugins/reflection-agent/document-previews.js',installed));
 const {validateReflection}=await import(new URL('runtime/revisions/validation.js',installed));
 const require=createRequire(await realpath(fileURLToPath(new URL('./node_modules/ember-rsi/package.json',import.meta.url))));
 const ExcelJS=require('exceljs');
 const workbook=new ExcelJS.Workbook();workbook.addWorksheet('Consumer').getCell('A1').value={formula:'1+1',result:2};
 const sourceFiles=${JSON.stringify(previewFixtures)};
 sourceFiles.push({path:'consumer.xlsx',mode:420,base64:Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64')});
 const artifactRef=await runtime.manager.artifacts.putJson({kind:'file-tree',files:sourceFiles});
 const previewFiles={};
 const previews=await prepareDocumentPreviews({sources:sourceFiles.map((file,index)=>({artifactRef,path:file.path,pointer:'/files/'+index,access:'delivery'})),files:previewFiles,artifacts:runtime.manager.artifacts,signal:new AbortController().signal});
 assert.deepEqual(previews.map(preview=>preview.inspection),['complete','complete','complete'],'installed parsers extract all supported formats');
 assert.match(JSON.stringify(previewFiles),/Top left/);assert.match(JSON.stringify(previewFiles),/Second page/);assert.match(JSON.stringify(previewFiles),/savedResult/);
 const targetDirectory=resolve(${JSON.stringify(outside)},'reflection-guidance');await mkdir(targetDirectory);
 const prompt=fileURLToPath(new URL('plugins/reflection-agent/prompt.md',installed));
 assert.match(await readFile(prompt,'utf8'),/selected plugin/);
 const reviewer=await packageResource(fileURLToPath(new URL('plugins/reflection-agent/reviewer.md',installed)));
 assert.ok((await readFile(reviewer,'utf8')).trim());
 const {createProjectSubagentTool}=await import(new URL('plugins/agent-pi/subagent.js',installed));
 const projectContext=context.extend({directory:${JSON.stringify(outside)},artifacts:runtime.manager.artifacts});
 const cwd=await prepareAgentProject(projectContext,'Delegate an inspection.',{},[],[{name:'reviewer',description:'Inspect evidence',prompt:reviewer}]);
 assert.equal((await createProjectSubagentTool({cwd,goal:'inspect',outputSchema:{}},projectContext)).name,'subagent','installed delegation tool loads without source checkout resources');
 for(const goal of ['generic','proposer','proposer-office','memory','selector']){
  const goalFile=fileURLToPath(new URL('plugins/reflection-agent/goals/'+goal+'/prompt.md',installed));
  const configFile=resolve(${JSON.stringify(outside)},'reflection-'+goal+'.json');
  await writeFile(configFile,JSON.stringify({evidence:['proposer'],targets:{proposer:{resources:['guidance']}},goal:goalFile,implementation:{contract:'contract.reflection',ref:'reflection.agent',config:{agentRef:'agent'}}}));
  const configuration=await validateReflection(configFile,{proposer:Binding.resolve({name:'proposer',registry:runtime.registry,required:proposerContract,override:{declaration:{plugin:'proposer.agent',config:{prompt,guidance:targetDirectory,agentRef:'agent'}},directory:${JSON.stringify(outside)}}}).toJSON(),agent:Binding.resolve({name:'agent',registry:runtime.registry,required:runtime.registry.get('agent.pi').contract,override:{declaration:{plugin:'agent.pi',config:{}},directory:${JSON.stringify(outside)}}}).toJSON()},id=>runtime.registry.get(id),id=>runtime.registry.contract(id));
  assert.equal(configuration.goal,await readFile(goalFile,'utf8'),'explicit installed goal selection loads contents');
  assert.equal(await realpath(configuration.implementation.config.prompt),await realpath(prompt),'installed generic prompt is the default');
 }
 for(const id of runtime.registry.catalog().policies){
  const path=await packageResource(runtime.registry.policy(id)),policy=await Policy.load(path,runtime.registry);
  assert.equal(policy.toJSON().schemaVersion,'rsi.policy/v1');
  if(id==='policy.gepa'){
   assert.deepEqual(policy.requirements.evolutionProposer,iterativeProposerContract,'installed GEPA Policy uses the shared iterative proposer contract');
   assert.deepEqual(runtime.registry.get('proposer.pareto-evolution').contract,iterativeProposerContract,'installed Pareto evolution proposer uses the shared iterative proposer contract');
   assert.deepEqual(runtime.registry.get('proposer.optuna').contract,iterativeProposerContract,'installed Optuna and Pareto evolution share one iterative proposer contract');
  }else{
   const requirement=policy.requirements.invariantProposer??policy.requirements.proposer;
   assert.deepEqual(requirement,id==='policy.parameter-grid'?gridProposerContract:id==='policy.parameter-optuna'?iterativeProposerContract:id==='policy.operator-search'?operatorProposerContract:proposerContract,'installed Policy and implementation share the public Proposer type');
  }
  assert.deepEqual(runtime.registry.get('proposer.agent').contract,proposerContract);
  const reflection=policy.defaults.reflection;
  if(reflection&&typeof reflection==='object'&&!Array.isArray(reflection))await readFile(await packageResource(resolve(dirname(path),reflection.configFile)),'utf8');
  const bindings=policy.defaults.bindings??{};
  for(const binding of Object.values(bindings)){
   if(binding.config?.prompt)assert.ok((await readFile(await packageResource(resolve(dirname(path),binding.config.prompt)),'utf8')).length);
   for(const skill of binding.config?.skills??[]){
    const resource=await packageResource(resolve(dirname(path),skill));
    assert.ok((await readFile(await packageResource((await stat(resource)).isDirectory()?resolve(resource,'SKILL.md'):resource),'utf8')).length);
   }
  }
  if(id==='policy.operator-search'){
   for(const resource of ['schemas/config.yaml','schemas/result.yaml'])assert.ok((await readFile(await packageResource(resolve(dirname(path),resource)),'utf8')).length);
   const promptsDirectory=await packageResource(resolve(dirname(path),bindings.proposer.config.promptsDirectory));
   for(const prompt of ['diagnose.md','generate.md','diagnose-metrics.md','generate-metrics.md','repair.md','summarize.md'])assert.ok((await readFile(await packageResource(resolve(promptsDirectory,prompt)),'utf8')).trim().length);
  }
 }
 const lifecycle=[],deliveries=[],admissions=[];
 let creations=0,disposals=0;
 runtime.registry.registerOperation({
  id:'consumer.application',contract:applicationContract,configSchema:{type:'object'},
  async create(_config,factoryCtx){
   factoryCtx.event.on('rsi/experiment-started',event=>lifecycle.push(['started',event.recipeId]));
   factoryCtx.event.on('rsi/experiment-finished',event=>{lifecycle.push(['finished',event.recipeId]);});
   return {async execute(_input,ctx){
    const artifact=await ctx.artifacts.putJson({kind:'file-tree',files:[]});
    return {action:'initialize',target:{},capabilities:[],initialCandidateRef:await ctx.recordCandidate(artifact,null)};
   },async dispose(){}};
  }
 });
 const contract=defineContract({id:'contract.consumer-worker',input_schema:{type:'object'},output_schema:{type:'object'}});
 runtime.registry.registerOperation({
  id:'consumer.worker',contract,configSchema:{type:'object'},
  async create(_config,factoryCtx){
   creations++;
   factoryCtx.event.on('consumer/notice',function(event,ctx){
    assert.equal(this.tag,'package');assert.equal(ctx.bindingId,'worker');
    assert.equal(ctx.event,factoryCtx.event);deliveries.push(event.count);
   });
   factoryCtx.event.on('rsi/before-call',async(event,next)=>{admissions.push(event.bindingId);return next();});
   return {async execute(_input,ctx){
    assert.equal(ctx.event,factoryCtx.event);
    await ctx.event.parallel({tag:'package'},'consumer/notice',{count:1});
    return {};
   },async dispose(){disposals++;}};
  }
 });
 const policyPath=resolve(${JSON.stringify(outside)},'consumer-policy.yaml');
 await writeFile(policyPath,JSON.stringify({
  schemaVersion:'rsi.policy/v1',id:'consumer.policy',input_schema:{type:'object'},output_schema:{type:'object'},
  require:{worker:{contract:contract.id},unused:{contract:contract.id}},
  steps:[{id:'first',type:'invoke',use:'worker',with:{}},{id:'second',type:'invoke',use:'worker',with:{}}],output:{}
 }));
 runtime.registry.registerPolicy('consumer.policy',policyPath);
 const recipePath=resolve(${JSON.stringify(outside)},'consumer-recipe.yaml');
 await writeFile(recipePath,JSON.stringify({
  schemaVersion:'rsi.recipe/v1',id:'consumer.recipe',application:{plugin:'consumer.application',config:{}},
  policy:{id:'consumer.policy',config:{},input:{}},budget:{operations:10,elapsedWallMs:10000},
  bindings:{worker:{plugin:'consumer.worker',config:{}},unused:{plugin:'consumer.worker',config:{}}}
 }));
 const experiment=await runtime.manager.run(recipePath,{id:'consumer.experiment'});
 assert.equal(experiment.status,'succeeded');assert.equal(experiment.recipeId,'consumer.recipe');
 assert.equal(creations,1);assert.equal(disposals,1);
 assert.deepEqual(deliveries,[1,1]);assert.deepEqual(admissions,['worker','worker']);
 assert.deepEqual(lifecycle,[['started','consumer.recipe'],['finished','consumer.recipe']]);
}finally{await runtime.dispose();}
console.log('Installed resources and managed ctx.event subscriptions, publishing, lazy creation and recipeId passed.');
`,
  );
  execFileSync(process.execPath, [join(consumer, 'consume.mjs')], {
    env: consumerEnv,
    cwd: outside,
    stdio: 'inherit',
    timeout: 30000,
  });
  run(
    [
      'add',
      '-D',
      `@deepseek-ai/cordis@${manifest.dependencies['@deepseek-ai/cordis']}`,
    ],
    consumer,
  );
  await writeFile(
    join(consumer, 'events-consumer.ts'),
    `
import type { Context, Events } from '@deepseek-ai/cordis';
import { Registry } from 'ember-rsi';
import { defineContract, RuntimeContext, type JsonObject, type Operation, type OperationDefinition, type EventPipeline, type OperatorbenchInput, type OperatorbenchOutput, type OperatorProposerInput, type OperatorProposerOutput, type MetricSelectorOutput } from 'ember-rsi/contracts';
declare module 'ember-rsi/contracts' {
 interface RuntimeContext { traceId?: string; }
}
const base=new RuntimeContext().extend({traceId:'consumer',local:1});
const child=base.extend({traceId:'child'});
const inherited:number=child.local;
const trace:string|undefined=child.traceId;
void inherited;void trace;
declare module '@deepseek-ai/cordis' {
 interface Events {
  'consumer/notice'(this: { tag: string }, event: { count: number }): void;
  'consumer/wait'(label: string): Promise<void>;
  'consumer/choice'(label: string): string | false | undefined;
  'consumer/chain'(value: number, next: () => Promise<number>): Promise<number>;
 }
}
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Check<T extends true>=T;
declare const pipeline:EventPipeline;
type Notice=Parameters<typeof pipeline.on<'consumer/notice'>>[1];
export type PublicChecks=[
 Check<Equal<OperatorbenchInput,{action:'evaluate';candidateRef:string;caseIds:string[]}|{action:'profile';candidateRef:string;caseIds:string[];assessmentMeasurementRef:string}>>,
 Check<Equal<OperatorbenchOutput,{action:'evaluate';measurementRef:string}|{action:'profile';measurementRef:string;collectionStatus:'completed'|'unavailable'}>>,
 Check<Equal<OperatorProposerInput['action'],'propose'|'repair'|'summarize'>>,
 Check<Equal<OperatorProposerOutput['action'],'propose'|'repair'|'summarize'>>,
 Check<Equal<Extract<OperatorProposerInput,{action:'propose';phase:'static'}>['baselineMeasurementRef'],string>>,
 Check<Equal<Extract<OperatorProposerOutput,{action:'propose';status:'created'}>['diffRef'],string>>,
 Check<Equal<MetricSelectorOutput['candidateValue'],number|null>>,
 Check<Equal<Parameters<Notice>[0],{count:number}>>,
 Check<Equal<Parameters<Notice>[1],RuntimeContext>>,
 Check<Equal<ThisParameterType<Notice>,{tag:string}>>,
 Check<Equal<ReturnType<Notice>,ReturnType<Events['consumer/notice']>>>,
 Check<Equal<RuntimeContext['event'],EventPipeline>>,
 Check<Equal<Parameters<RuntimeContext['invoke']>,[binding:string,input:import('ember-rsi/contracts').JsonValue]>>
];
export const definition:OperationDefinition<JsonObject,JsonObject,{prefix:string}>={
 id:'consumer.typed-events',
 contract:defineContract({id:'contract.consumer-events',input_schema:{type:'object'},output_schema:{type:'object'}}),
 configSchema:{type:'object'},
 async create(config,services){
  const instance:Operation<JsonObject,JsonObject>={async execute(input){return input;},async dispose(){}};
  services.event.on('consumer/notice',function(event,context){const trace:string|undefined=context.traceId;void trace;if(!config.prefix||!context.callId||!this.tag||event.count<0)throw new Error('Invalid listener state');});
  services.event.on('rsi/before-experiment',async()=>undefined);
  services.event.on('rsi/before-call',async(_event,next)=>next());
  services.event.emit({tag:'publisher'},'consumer/notice',{count:1});
  await services.event.parallel('consumer/wait','parallel');
  await services.event.serial('consumer/choice','serial');
  const decision:string|false|undefined=services.event.bail('consumer/choice','bail');
  const result:number=await services.event.waterfall('consumer/chain',1,async()=>2);
  void decision;void result;
  return instance;
 },
};
new Registry().registerOperation(definition);
`,
  );
  await writeFile(
    join(consumer, 'contracts-consumer.ts'),
    `
import { RuntimeContext, type OperationDefinition } from 'ember-rsi/contracts';
import type { IterativeProposerInput, IterativeProposerOutput } from 'ember-rsi';
import type { IterativeProposerInput as ContractIterativeProposerInput, IterativeProposerOutput as ContractIterativeProposerOutput } from 'ember-rsi/contracts';
declare module 'ember-rsi/contracts' {
 interface RuntimeContext { contractsOnlyTrace?: string; }
}
const context=new RuntimeContext().extend({contractsOnlyTrace:'consumer'});
const signal:AbortSignal=context.signal;
const result:Promise<import('ember-rsi/contracts').JsonValue>=context.invoke('worker',{});
void signal;void result;
export function checkIterativeProposerInput(candidateRef:string,feedbackTaskIds:string[],selectionTaskIds:string[]):IterativeProposerInput {
 const input:ContractIterativeProposerInput={action:'initialize',parent:candidateRef,feedbackTaskIds,selectionTaskIds};
 return input;
}
export function checkIterativeProposerOutput(output:IterativeProposerOutput):ContractIterativeProposerOutput {
 return output;
}
export function checkOperation(definition:OperationDefinition):void {
 const operation=definition.create({},context);
 void operation;
}
export function checkExecution(context:Parameters<OperationDefinition['create']>[1]):void {
 const trace:string|undefined=context.contractsOnlyTrace;
 void trace;
 context.event.on('rsi/call-succeeded',(_event,scope)=>{
  const inherited:string|undefined=scope.contractsOnlyTrace;
  const signal:AbortSignal=scope.signal;
  void inherited;void signal;
 });
}
`,
  );
  await checkOperatorConsumer(consumer, operatorExample);
  const compiler = join(root, 'node_modules/typescript/bin/tsc');
  const compileArgs = [
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--skipLibCheck',
  ];
  for (const file of ['contracts-consumer.ts', 'events-consumer.ts']) {
    execFileSync(process.execPath, [compiler, ...compileArgs, file], {
      env: consumerEnv,
      cwd: consumer,
      stdio: 'inherit',
      timeout: 30000,
    });
  }
  const invalidConsumers = {
    'unknown-event': `services.event.emit('consumer/missing', {});`,
    'event-payload': `services.event.emit({tag:'publisher'}, 'consumer/notice', {count:'wrong'});`,
    'event-this': `services.event.emit({tag:1}, 'consumer/notice', {count:1});`,
    'definition-listeners': `import {definition} from './events-consumer.js'; const invalid:typeof definition={...definition,listeners:{}};void invalid;`,
    'listener-context': `services.event.on('consumer/notice',(_event,context:string)=>{void context;});`,
    'serial-return': `services.event.on('rsi/before-experiment',()=>true);`,
    'admission-return': `services.event.on('rsi/before-call',async()=>({kind:'invalid'}));`,
    'context-extension': `services.extend({traceId:123});`,
    'context-signal': `services.extend({signal:'invalid'});`,
    'unbound-context-service': `const invoke=services.invoke;invoke('worker',{});`,
  };
  for (const [name, source] of Object.entries(invalidConsumers)) {
    const file = `invalid-${name}.ts`;
    await writeFile(
      join(consumer, file),
      `import './events-consumer.js';import type {RuntimeContext} from 'ember-rsi/contracts';declare const services:RuntimeContext;${source}\n`,
    );
    let diagnostics = '';
    try {
      execFileSync(process.execPath, [compiler, ...compileArgs, file], {
        env: consumerEnv,
        cwd: consumer,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
      });
      assert.fail(`${name} unexpectedly passed public type checking`);
    } catch (error) {
      if (!('stdout' in error)) throw error;
      diagnostics = String(error.stdout);
    }
    assert.match(
      diagnostics,
      /error TS(?:2322|2345|2353|2684|2769)/,
      `${name} fails at the public context or event contract`,
    );
  }
  console.log(
    'Package consumption passed: isolated tarball install, executable, catalog, Recipe validation, operator search with external retrieval resources, operator contracts and public context/event/kernel/operator typing.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
