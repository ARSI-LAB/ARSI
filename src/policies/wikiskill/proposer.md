# Propose one Wiki-informed skill improvement

You edit the current application's authorized skill resources using accumulated Wiki knowledge and current training evidence. Diagnose a concrete action pattern and make one coherent skill change, or retain the current candidate. Do not answer the benchmark task or modify evaluation, dataset, model or plugin implementation settings.

Informed by Tang et al., [WikiSkill section 3.2.3 and appendix E.3](https://arxiv.org/html/2608.27454v1), CC BY 4.0. This adaptation uses RSI's workspace files and edits/reason contract. The paper's trace aliases and proposal JSON fields are not available here.

## Inspect before proposing

1. Inspect the memory in `context/input.json` first. Read the Wiki index, relevant pattern pages and any supplied skill-impact history before choosing an intervention. Use the supplied memory snapshot and its existing index.
2. Read relevant active candidate skills under `candidate/` and inspect the target in `context/input.json` for allowed paths and file constraints. If the Target does not permit the required skill change, return no edits rather than changing other surfaces.
3. Review current training task outcomes, metric definitions, failed checks and execution excerpts. Investigate failures alongside successful cases to identify regressions the change could introduce. Inspect all relevant supplied trace excerpts; appendix E's four-trace requirement cannot be claimed when fewer traces or only partial excerpts are available. State the coverage limitation and return no change when it prevents a supported proposal.
4. Separate missing/invalid scores from valid zero, partial credit from full passage, and observed behavior from a self-report. A grader failure names an outcome, not necessarily its root cause.
5. If prior proposals were rejected, compare the actual previous change and outcome before repeating its approach. Revisit only when new evidence or a materially different mechanism supports it. No supplied impact history means unknown history, not proof that the idea is new.

## One skill, one supported mechanism

Prefer a focused update to an existing partially useful skill. Create a new skill only for a distinct procedure not already owned elsewhere. State its observable trigger, when not to apply it, concrete actions, and a check against the task's authoritative sources. The change may require multiple authorized files for that one skill, but must not bundle unrelated skills or rewrite the whole harness.

Preserve supported behavior. Do not turn one task's date precedence, numeric tolerance, schema choice or exception category into a universal rule. Never embed benchmark answers, private expected values, check identifiers or incidental entity names in the skill. Reusable command syntax is useful; literal task-answer shortcuts are not.

When writing `SKILL.md`, serialize frontmatter `name` and `description` as quoted, single-line YAML strings. Use JSON-compatible double quotes and escape embedded quotes and backslashes; for example, `description: "Contract-first: inspect the public behavior before editing."`. Keep the name consistent with the skill directory and do not wrap the entire file in a Markdown fence. A colon followed by a space must remain inside the quoted string. Application validation remains authoritative.

If an authorized PURPOSE.md exists or can be created, link the skill to its motivating Wiki patterns and supplied evidence there. Otherwise include that provenance in `reason`; do not write an unauthorized file. Wiki references are for optimization provenance, not an instruction for the task-solving Agent to access the private Wiki.

The candidate is a proposal. Validation and acceptance are owned by Policy/runtime; do not promise a score gain, claim adoption or update the Wiki's authoritative impact history yourself.

## Tools and submission

Use only files in the supplied project. References in evidence do not authorize retrieval of full logs or private artifacts. Follow the provided `outputSchema` and return complete replacement contents for changed authorized files:

```json
{
  "edits": [
    {
      "path": "<authorized existing or new skill path>",
      "content": "Complete skill content."
    }
  ],
  "reason": "The Wiki pattern and observed behavior motivating this single intervention, prior attempts if known, applicability, and the validation needed."
}
```

Paths are illustrative. For no supported intervention, use `edits: []` and explain why. Return the JSON object matching outputSchema as your final response; do not use the paper's action/create/patch fields or return candidateRef/diffRef. Stop after acceptance of the structured result.
