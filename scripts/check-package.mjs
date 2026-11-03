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
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'rsi-package-')));
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
      env: process.env,
      timeout: 600000,
      encoding: 'utf8',
    },
  );
}
try {
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
    cwd: outside,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(
    help,
    /ember-rsi run <recipe.yaml>/,
    'installed executable works outside its source checkout',
  );
  assert.match(help, /reflection apply <revisionID>/);
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
    cwd: outside,
    encoding: 'utf8',
    timeout: 30000,
    shell: process.platform === 'win32',
  });
  assert.match(binHelp, /ember-rsi list/);

  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, [command, 'reflection', 'list'], {
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
          { cwd: outside, encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
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
    'schemaVersion: rsi.policy/v1\nid: external.policy\ninput_schema: { type: object }\noutput_schema: { type: object }\noutput: {}\n',
  );
  const externalCatalog = JSON.parse(
    execFileSync(
      process.execPath,
      [command, 'catalog', '--plugin-dir', extension],
      {
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
      cwd: outside,
      encoding: 'utf8',
      timeout: 30000,
    }),
  );
  assert.equal(
    catalog.plugins.length,
    13,
    'all thirteen plugin definitions ship in the archive',
  );
  assert.ok(catalog.plugins.includes('agent.codex'));
  assert.deepEqual(
    [...catalog.policies].sort(),
    [
      'policy.harness2',
      'policy.parameter-grid',
      'policy.parameter-optuna',
      'policy.wikiskill',
    ],
    'all built-in policies ship in the archive',
  );
  for (const name of ['dsh-harness2', 'dsh-wikiskill']) {
    const example = join(outside, name);
    await cp(join(root, 'examples/harness', name), example, {
      recursive: true,
    });
    const validation = JSON.parse(
      execFileSync(
        process.execPath,
        [command, 'validate', join(example, 'recipe.yaml')],
        {
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
  }
  for (const name of ['shared', 'parameter-grid', 'parameter-tpe']) {
    await cp(
      join(root, 'examples/artifacts/inference', name),
      join(outside, name),
      { recursive: true },
    );
  }
  for (const name of ['parameter-grid', 'parameter-tpe']) {
    const inferenceValidation = JSON.parse(
      execFileSync(
        process.execPath,
        [command, 'validate', join(outside, name, 'recipe.yaml')],
        { cwd: outside, encoding: 'utf8', timeout: 30000 },
      ),
    );
    assert.equal(
      inferenceValidation.valid,
      true,
      `installed package validates ${name} without source paths`,
    );
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
        cwd: outside,
        input: JSON.stringify({ action: 'check' }),
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.equal(checked.environment.optuna, '4.5.0');
    const sampled = JSON.parse(
      execFileSync(process.env.RSI_OPTUNA_PYTHON, [packagedWorker], {
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
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import assert from 'node:assert/strict'; const sdk = await import('ember-evaluator'); assert.equal(typeof sdk.Evaluator, 'function'); assert.equal(typeof sdk.parseUserConfig, 'function');",
    ],
    {
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
import {readFile,realpath,stat,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createRuntime,readPolicy,proposerContract,gridProposerContract,parameterSearchProposerContract,applicationContract,defineContract,RuntimeContext} from 'ember-rsi';
import {RuntimeContext as ContractContext} from 'ember-rsi/contracts';
assert.equal(RuntimeContext,ContractContext);
const context=new RuntimeContext().extend({traceId:'consumer'});
const runtime=await createRuntime({rootDirectory:${JSON.stringify(outside)},context});
assert.equal(runtime.context.traceId,'consumer');
try {
 const installed=new URL('./node_modules/ember-rsi/dist/src/',import.meta.url);
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
 const {createSubagentTool}=await import(new URL('plugins/agent-pi/subagent.js',installed));
 assert.equal(createSubagentTool({goal:'inspect',prompt:'inspect',outputSchema:{}},context).name,'run_subagent','installed delegation tool loads without source checkout resources');
 for(const goal of ['generic','proposer','proposer-office','memory','selector']){
  const goalFile=fileURLToPath(new URL('plugins/reflection-agent/goals/'+goal+'/prompt.md',installed));
  const configFile=resolve(${JSON.stringify(outside)},'reflection-'+goal+'.json');
  await writeFile(configFile,JSON.stringify({evidence:['proposer'],targets:{proposer:{resources:['guidance']}},goal:goalFile,implementation:{contract:'contract.reflection',ref:'reflection.agent',config:{agentRef:'agent'}}}));
  const configuration=await validateReflection(configFile,{proposer:{ref:'proposer.agent',config:{prompt,guidance:targetDirectory}},agent:{ref:'agent.pi',config:{}}},id=>runtime.registry.get(id),id=>runtime.registry.contract(id));
  assert.equal(configuration.goal,await readFile(goalFile,'utf8'),'explicit installed goal selection loads contents');
  assert.equal(await realpath(configuration.implementation.config.prompt),await realpath(prompt),'installed generic prompt is the default');
 }
 for(const id of runtime.registry.catalog().policies){
  const path=runtime.registry.policy(id),policy=await readPolicy(path,runtime.registry);
  assert.equal(policy.definition.schemaVersion,'rsi.policy/v1');
  const requirement=policy.require.invariantProposer??policy.require.proposer;
  assert.deepEqual(requirement,id==='policy.parameter-grid'?gridProposerContract:id==='policy.parameter-optuna'?parameterSearchProposerContract:proposerContract,'installed Policy and implementation share the public Proposer type');
  assert.deepEqual(runtime.registry.get('proposer.agent').contract,proposerContract);
  const reflection=policy.defaults.reflection;
  if(reflection&&typeof reflection==='object'&&!Array.isArray(reflection))await readFile(resolve(dirname(path),reflection.configFile),'utf8');
  const bindings=policy.defaults.bindings??{};
  for(const binding of Object.values(bindings)){
   if(binding.config?.prompt)assert.ok((await readFile(resolve(dirname(path),binding.config.prompt),'utf8')).length);
   for(const skill of binding.config?.skills??[]){
    const resource=resolve(dirname(path),skill);
    assert.ok((await readFile((await stat(resource)).isDirectory()?resolve(resource,'SKILL.md'):resource,'utf8')).length);
   }
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
  init:{steps:[{id:'first',use:'worker',with:{}},{id:'second',use:'worker',with:{}}]},output:{}
 }));
 runtime.registry.registerPolicy('consumer.policy',policyPath);
 const recipePath=resolve(${JSON.stringify(outside)},'consumer-recipe.yaml');
 await writeFile(recipePath,JSON.stringify({
  schemaVersion:'rsi.recipe/v1',id:'consumer.recipe',application:{ref:'consumer.application',config:{}},
  policy:{ref:'consumer.policy',config:{},input:{}},budget:{operations:10,elapsedWallMs:10000},
  bindings:{worker:{ref:'consumer.worker',config:{}},unused:{ref:'consumer.worker',config:{}}}
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
import { defineContract, RuntimeContext, type JsonObject, type Operation, type OperationDefinition, type EventPipeline } from 'ember-rsi/contracts';
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
declare module 'ember-rsi/contracts' {
 interface RuntimeContext { contractsOnlyTrace?: string; }
}
const context=new RuntimeContext().extend({contractsOnlyTrace:'consumer'});
const signal:AbortSignal=context.signal;
const result:Promise<import('ember-rsi/contracts').JsonValue>=context.invoke('worker',{});
void signal;void result;
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
    'Package consumption passed: isolated tarball install, executable, catalog, Recipe validation, packaged resources and public context/event typing.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
