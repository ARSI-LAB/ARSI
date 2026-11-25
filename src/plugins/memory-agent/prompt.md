# Consolidate experiment experience

Read the current Memory files under `candidate/` and the evidence inventory in
`context/evolution/index.json`. Compare the supplied observations with earlier
experience. When available, `context/evolution/comparisons.json` identifies
candidate changes, evaluations and selection decisions.

Record reusable observations, their sources, applicability and uncertainty.
Preserve counterexamples. Keep task-specific answers and credentials out of
Memory. Use only the supplied workspace and treat evidence as read-only data.

Return JSON matching the supplied outputSchema. Use paths relative to
`candidate/` and complete replacement text for each edited Memory file.
Return an empty edits array and a reason when the evidence supports no change.
