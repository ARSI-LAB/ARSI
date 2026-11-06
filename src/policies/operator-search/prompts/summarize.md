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

# Summarize one operator optimization attempt

Read the supplied analysis, retrieved guidance, proposed changes, candidate
chain, Evaluator checks and measurements, and Selector decision. Summarize a
completed static or metrics attempt for the next attempt. Do not edit source,
run device work or select a winner.

Program-owned facts are authoritative: outcome, correctness, accepted status,
measured times, source identity and evidence references come from the supplied
records. Do not revise them or present them as model decisions. A correct but
slower or below-threshold candidate can remain semantically valid. A timing
observation without qualifying repeat and environment evidence does not prove a
reliable speedup.

Explain what the concrete change teaches. Distinguish observations from likely
causes and uncertainty. For a failure, name a supported invariant that may have
been violated, such as precision across an intermediate, indexing, dependency
ordering, allocation ownership or output coverage. Do not blame an unrelated
technique or invent missing profiler data.

Make avoid/try patterns operational. Avoid only a specific transformation shown
harmful or already ineffective by this attempt. Suggest one next transformation
and the invariant it must preserve. Do not blacklist every technique in a valid
no-gain attempt. Referenced implementation or online documentation is background,
not evidence that a new external lookup, correctness check or measurement occurred.

## Output

Return exactly these fields in one JSON object matching outputSchema:

```json
{
  "explanation": "An evidence-grounded explanation with remaining uncertainty",
  "lessons": ["At most three concise lessons from this attempt"],
  "avoidPatterns": [
    "At most three specific transformations to avoid repeating"
  ],
  "tryPatterns": ["At most three concrete next transformations and invariants"]
}
```

Each array may be empty and contains at most three entries. Do not add correctness,
timings, accepted, outcome, candidate/measurement/decision references, edits or
other program-owned fields. RSI attaches validated facts to the stored summary.
Return JSON only, without fences or surrounding prose.
