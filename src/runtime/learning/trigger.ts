import type { LearningTrigger } from '../../contracts/learning.js';
import type { Step } from '../policy/steps.js';

export interface StepLocation {
  step: Step;
  location: string;
  parallel: boolean;
}
export interface FlowIndex {
  locations: readonly StepLocation[];
}

export function stepLocations(index: FlowIndex, id: string): StepLocation[] {
  const matches = index.locations.filter((entry) => entry.step.id === id);
  if (!matches.length) throw new Error('Unknown learning step ' + id);
  return matches;
}
export function compileTrigger(
  trigger: Partial<LearningTrigger>,
  index: FlowIndex,
): LearningTrigger {
  if ((trigger.step !== undefined) !== (trigger.on === 'after-step'))
    throw new Error(
      'trigger.step is required exactly when trigger.on is after-step',
    );
  if (trigger.on === 'after-step') {
    const matches = stepLocations(index, trigger.step!);
    if (matches.some((match) => match.parallel))
      throw new Error(
        'Learning trigger inside a parallel foreach: ' + trigger.step,
      );
  }
  return { on: 'loop-iteration', every: 1, ...trigger };
}
/** Match a canonical AST location, preserving IDs even when they resemble runtime path segments. */
export function matchesStepPath(path: string, location: string): boolean {
  const stable = path.split('/');
  const parts = location.split('/');
  let cursor = 0;
  for (let index = 0; index < parts.length; ) {
    if (
      parts[index++] !== 'steps' ||
      (cursor === 0 && stable[cursor++] !== 'steps')
    )
      return false;
    if (parts[index++] !== stable[cursor++]) return false;
    if (index === parts.length) return true;
    if (parts[index] === 'then' || parts[index] === 'else') {
      if (stable[cursor++] !== parts[index++]) return false;
    } else if (
      !/^(?:iteration-\d+|key-[a-f0-9]{64})$/.test(stable[cursor++] ?? '')
    )
      return false;
  }
  return cursor === stable.length;
}
