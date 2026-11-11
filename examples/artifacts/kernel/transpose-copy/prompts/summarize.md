<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

-->

# Summarize one completed operator optimization attempt

Read the supplied diagnosis, matched techniques, proposed changes, candidate chain,
Evaluator checks and measurements, and Selector decision. Explain what this
attempt teaches the next attempt. This is an independent summary action after
an attempt, including the final attempt. It does not edit source or select a winner.

Program-owned facts are authoritative: attempt outcome, correctness, accepted
status, measured times, source identity and evidence references are supplied by
RSI. Do not change or reproduce those facts as your own decisions. In particular,
a correct but slower or below-threshold transformation can remain semantically
correct; a measurement without qualifying evidence is not a proven improvement.
A proposed cause is an explanation with uncertainty, not a replacement fact.

Ground conclusions in this attempt's source changes and actual feedback. When
correctness failed, identify the likely violated invariant, such as effective
precision across a store/load, an index equation, a removed consumer, or a loop
trip count. Do not assert a root cause unsupported by the available evidence.
When several changes were made, name the most likely mechanism without blaming
unrelated techniques. Missing profiler metrics stay unknown.

Make avoid/try patterns operational. Avoid only a concrete transformation shown
harmful or already ineffective by this attempt. Suggest one source transformation
with the invariant it must preserve, rather than bundling math, tiling and fusion.
Do not automatically blacklist every technique used in a correct no-gain attempt.

## Output

Return exactly these fields in one JSON object matching outputSchema:

```json
{
  "explanation": "An evidence-grounded explanation of the observed outcome and remaining uncertainty",
  "lessons": [
    {
      "text": "An observation from the supplied formal measurement",
      "basis": "evaluation"
    }
  ],
  "avoidPatterns": [
    {
      "text": "A specifically reported local probe, not a formal result",
      "basis": "agent-report"
    }
  ],
  "tryPatterns": [
    { "text": "A concrete next test and its invariant", "basis": "hypothesis" }
  ]
}
```

The arrays may be empty. Do not include wasTransformCorrect, correctness, timings,
accepted, outcome, candidate/measurement/decision references, edits, or any other
program-owned field. RSI attaches those validated facts to the stored summary.
Return JSON only, without a Markdown fence or surrounding prose.

Acceptance records the Selector's decision from the supplied measurements. Report timing differences as observations from those measurements. Claims about reliable speedup require independent repeat measurements and environment evidence supplied with this attempt.

## Evidence strength

Every item in lessons, avoidPatterns and tryPatterns must have exactly `text` and
`basis`. Use `evaluation` only for direct observations supported by this attempt's
formal `measurementRefs` and supplied Evaluator evidence. Existing incumbent
timing alone is not an evaluation of an unsubmitted candidate. If measurementRefs
is empty, no item may use `evaluation`.

Use `agent-report` for claims in action rationales, including temporary benchmarks
or alleged failures not represented by formal measurement evidence. Use
`hypothesis` for causal explanations, static arguments and proposed future tests.
Do not promote a local timing report into a formal result or a causal hypothesis
into a proven mechanism. Missing evidence stays unknown.

A no-change round adds no candidate measurement. Do not describe it as another
failed measured experiment or use it to blacklist a whole transformation family.
Keep avoid patterns specific to the tested source and conditions. Try patterns
are optional experiments, not new prerequisites for all future edits. Do not
require proven speedup or additional profiler counters before any plausible
contract-preserving candidate may be submitted. The arrays may be empty.
