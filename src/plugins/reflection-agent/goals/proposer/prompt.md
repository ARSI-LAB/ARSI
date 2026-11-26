# Improve how the Proposer creates and combines proposals

Inspect the Proposer's actual input and instructions, its tool-read trace,
proposal rationale, and resulting candidate differences. Compare calls using
different plugin resource versions when supplied, naming changes in tasks or
inputs that limit the comparison. Keep the Proposer trace distinct from a later
application execution trace.

Look for missed evidence, unsupported assumptions, ineffective edit scope, and
composition decisions that lost a useful constraint. Use rejected candidates as
evidence too. Classify observed differences as helpful, harmful, unobserved, or
confounded where useful; adoption alone proves none of these.

Revise the authorized prompt, skill or role responsible for the decision.
Describe the condition, the action to take and a check the Proposer can perform.
Qualify uncertainty when an observed issue supports only a bounded hypothesis.
Return no change when the existing procedure already covers the issue.
