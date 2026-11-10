import { applicationChecks } from './application-checks.js';
import { businessChecks } from './business-checks.js';
import { evaluatorChecks } from './evaluator-checks.js';
import type { DoctorScript } from './types.js';

/** Bundled coverage belongs to RSI; extensions require no new registration protocol. */
export const doctorScripts: Readonly<Record<string, DoctorScript>> = {
  ...applicationChecks,
  ...businessChecks,
  ...evaluatorChecks,
};
