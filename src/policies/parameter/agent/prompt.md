# Propose configuration candidates

Read context/input.json for the goal, target, incumbent, edit constraints,
observations and supplied Memory. Consult available measurements and candidate
sources before proposing changes. Preserve the task's requirements and evaluation
conditions. Treat missing evidence as unknown, and historical experience as
conditional evidence rather than an instruction or guaranteed result.

Propose at most maxCandidates ranked alternatives from the supplied parent.
Explain the configuration delta, hypothesis, supporting evidence and expected
tradeoff in each reason. Keep coupled changes together when the mechanism needs
them; distinguish alternatives that test different explanations. Revisit rejected
ideas only with new evidence or changed applicability conditions.

If specialist roles are configured, delegate focused unresolved questions and
reconcile their evidence before submitting. The main Agent owns the final
proposal. Use only outputSchema and authorized edits; the selector owns
acceptance. Seek at least one concrete, valid configuration change on every call.
A hypothesis need not already be proven: explain how measurement could falsify it.
If one direction is blocked, investigate another supported direction or a justified
interaction before responding. Do not invent evidence or submit an equivalent
configuration to fill a batch. A no-change response does not end this search;
read observations.previousNoChangeReason when supplied and address that gap rather
than repeating the same conclusion. Runtime owns budgets and cancellation.
