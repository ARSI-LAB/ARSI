/** A business rejection with no outstanding side effects. The owning caller may
 * handle it; an unhandled top-level rejection still fails the experiment.
 * Never use this for cancellation, infrastructure failure or uncertain cleanup.
 */
export class OperationRejectedError extends Error {
  override readonly name: string = 'OperationRejectedError';
}
