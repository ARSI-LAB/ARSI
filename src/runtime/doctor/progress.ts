import type { DoctorCheck, DoctorReport } from '../../contracts/index.js';

export type DoctorProgress =
  | {
      readonly kind: 'recipe-validated';
      readonly recipeId: string;
      readonly totalBindings: number;
    }
  | {
      readonly kind: 'binding-started';
      readonly index: number;
      readonly total: number;
      readonly binding: string;
      readonly pluginId: string;
    }
  | {
      readonly kind: 'binding-detail';
      readonly binding: string;
      readonly pluginId: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'binding-completed';
      readonly index: number;
      readonly total: number;
      readonly binding: string;
      readonly pluginId: string;
      readonly passed: number;
      readonly failed: number;
      readonly unchecked: number;
      readonly checks: readonly DoctorCheck[];
    }
  | { readonly kind: 'cleaning' }
  | { readonly kind: 'finished'; readonly report: DoctorReport };

export type DoctorProgressReporter = (event: DoctorProgress) => void;
export type DoctorProgressObserver = (
  event: DoctorProgress,
) => void | Promise<void>;

/** Best-effort progress wrapper; never affects doctor checks or outcomes. */
export function doctorProgressReporter(
  observe: DoctorProgressObserver | undefined,
): DoctorProgressReporter | undefined {
  if (!observe) return undefined;
  return (event) => {
    try {
      const pending = observe(structuredClone(event));
      if (pending) void pending.catch(() => {});
    } catch {
      // Reporting is best effort.
    }
  };
}
