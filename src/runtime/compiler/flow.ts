import type {
  JsonObject,
  JsonSchema,
  PluginContract,
} from '../../contracts/index.js';
import { scopeRoots, validateTemplate, type Scope } from './scope.js';
import type { Step, StepValidationContext, Template } from '../policy/steps.js';

export function compileFlow(policy: {
  inputDefaults: JsonObject;
  stateInitial: JsonObject;
  stateSchema: JsonSchema;
  steps: readonly Step[];
  output: Template;
  requirements: Readonly<Record<string, PluginContract>>;
  defaults: JsonObject;
}): void {
  const base: Scope = {
    names: scopeRoots,
    frames: [],
    parallel: false,
    loopDepth: 0,
  };
  validateTemplate(
    policy.inputDefaults,
    { ...base, names: ['application', 'config'] },
    'policy.input',
  );
  validateTemplate(
    policy.stateInitial,
    { ...base, names: ['application', 'config', 'input'] },
    'policy.state',
  );
  function visit(
    steps: readonly Step[],
    scope: Scope,
    label: string,
    output?: Template,
  ): void {
    const completed = new Set<string>();
    const local = {
      ...scope,
      frames: [
        ...scope.frames,
        { declared: new Set(steps.map((step) => step.id)), completed },
      ],
    };
    for (const step of steps) {
      const context: StepValidationContext = {
        label: `${label}/${step.id}`,
        requirements: policy.requirements,
        stateSchema: policy.stateSchema,
        parallel: local.parallel,
        loopDepth: local.loopDepth,
        reflectionDeclared: policy.defaults.reflection !== undefined,
        names: local.names,
        validateTemplate(template, locals = []) {
          validateTemplate(template, local, this.label, locals);
        },
        validateSteps(children, options) {
          visit(
            children,
            {
              ...local,
              names: [...local.names, ...(options.locals ?? [])],
              parallel: local.parallel || (options.parallel ?? false),
              loopDepth: options.loopDepth ?? local.loopDepth,
            },
            `${this.label}/${options.scope}`,
            options.output,
          );
        },
      };
      step.validate(context);
      if (step.type !== 'control') completed.add(step.id);
    }
    if (output !== undefined)
      validateTemplate(output, local, `${label}.output`);
  }
  visit(policy.steps, base, 'steps', policy.output);
}
