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
acceptance. Return no change when no justified candidate remains.
