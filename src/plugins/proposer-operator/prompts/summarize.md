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

Source: ngo-agent@e8bf53c0d9d70200d235c761f5e7472118b8e898:src/ngo_agent/kernel_agent/triton_kernel_agent/templates/static_reflexion_prompt.j2
Adaptation: Preserved source-level causal lessons and operational avoid/try guidance; correctness, timing, outcome and acceptance are supplied facts, so output is limited to explanation and bounded lesson lists.
-->

# Summarize one completed static optimization attempt

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
  "lessons": ["At most three concise lessons grounded in this attempt"],
  "avoidPatterns": [
    "At most three specific transformations to avoid repeating"
  ],
  "tryPatterns": [
    "At most three concrete next transformations and their invariants"
  ]
}
```

The arrays may be empty. Do not include wasTransformCorrect, correctness, timings,
accepted, outcome, candidate/measurement/decision references, edits, or any other
program-owned field. RSI attaches those validated facts to the stored summary.
Return JSON only, without a Markdown fence or surrounding prose.

Acceptance records an observed improvement in this search, not calibrated performance confidence. Do not claim a reliable speedup from acceptance alone; calibration and independent retest confidence are reported separately by RSI.
