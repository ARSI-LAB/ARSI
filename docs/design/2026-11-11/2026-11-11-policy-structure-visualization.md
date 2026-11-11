# Policy structure visualization in the dashboard

Date: 2026-11-11
Last discussion: 2026-11-12
Version: 1
Accepted: 2026-11-12
Status: Accepted first-version design; Decisions 1–23 and the implementation specification are the implementation baseline. Implementation has not started.

## Confirmed intent

Extend the existing dashboard with a visualization of Policy structure. Derive the structure from Policy declarations; use Recipe information only where the agreed presentation requires it. The discussion rounds and final source-based review are complete. This document defines the first-version design and its implementation specification.

## Design overview

| Area             | Agreed direction                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Entry and source | A Policy tab in experiment details, reading the initial saved Policy/Recipe definition.                       |
| Flow view        | All seven step types, nested containers, top-level initial view, top-to-bottom layout.                        |
| Data view        | Grouped nodes with field-level dependencies, scoped sources, explicit compound outputs, left-to-right layout. |
| Interaction      | Right-side details, cross-view step selection, local filtering and expansion, focused/full data views.        |
| Analysis         | Backend static projection, all declared branches retained, explicit partial-result diagnostics.               |
| Delivery         | One read-only response for both graphs and their redacted details; frontend owns layout and interaction.      |
| Acceptance       | Deterministic semantic/API tests and browser verification; no real model or evaluation runs required.         |

The numbered decisions preserve the agreed requirements. The implementation specification below defines how to implement them; renderer selection and measured resource bounds are explicitly left to implementation verification.

## Current implementation: inspected facts

- The [experiment detail view](../../../web/features/experiments/experiment-detail.tsx) provides Overview, Call history, Candidates, Measurements, Reflection & Memory, Recipe, and Results views. It does not currently offer a Policy structure view.
- The [Recipe view](../../../web/features/experiments/recipe.tsx) reads the experiment details endpoint. [Observation queries](../../../src/runtime/services/observation.ts) expose recorded Recipe configuration as a preview, rather than a dedicated Policy structure model.
- The [Policy implementation](../../../src/runtime/policy/policy.ts) validates a declaration using registered contracts, compiles its flow, and exposes a serializable declaration through `toJSON()`.
- The [document loader](../../../src/runtime/compiler/document.ts) expands local file references. Reading only the top-level YAML without resolving those references can omit parts of the declaration.
- The [flow compiler](../../../src/runtime/compiler/flow.ts) validates nested scopes and expression references. The supported step types are `invoke`, `state`, `if`, `foreach`, `loop`, `control`, and `reflection`, as described in the [Policy authoring guide](../../users/guides/writing-policies.md).
- The [expression implementation](../../../src/runtime/policy/expression.ts) exposes an expression AST and reference-path traversal, including indexed access. These are existing building blocks for dependency extraction; their use for visualization has not been implemented or verified.
- The [Recipe contract](../../../src/contracts/recipe.ts) selects a Policy through `policy.id` and supplies configuration, input, and binding overrides. A Policy declaration carries its own steps, contract requirements, and optional default bindings.
- The [definition lock](../../../src/runtime/manager/definition-lock.ts) includes both the normalized Recipe and `recipe.policy.toJSON()`. Decisions 11 and 16 select this initial saved definition as the visualization source.
- The [Reflection configuration validator](../../../src/runtime/revisions/validation.ts) identifies target bindings and authorized resource fields. The [Reflection guide](../../users/guides/reflection.md) describes revisions of plugin resources such as guidance and an existing Reflection & Memory view. These revisions must not be treated as new Policy step structures merely because their resource contents changed.

The references above describe inspected source code, not verification of a new visualization.

## Agreed first-version scope

Decision 1: The user selected static structure visualization (option A). The first version provides a read-only view of the declared Policy structure. A user should be able to understand the ordered steps, nested branches, repeated regions, and declared plugin calls without executing the Policy.

Decision 7 extends this static scope with a separate data relationship view, described below.

Execution status overlays, observed branch outcomes, actual iteration instances, and measured results are outside the first-version scope. The visualization must not depend on execution traces to construct the structure.

## Agreed dashboard entry point

Decision 2: Add a dedicated Policy tab within experiment details, alongside the existing Recipe and Call history views. This tab provides the space for the static structure visualization of the experiment's Policy.

The existing Recipe view remains available for viewing the overall configuration. A standalone Policy browser is outside the first-version scope. Selecting an experiment provides the viewing context; it does not make execution traces a prerequisite for constructing the graph.

## Agreed structure and configuration layers

Decision 3: Show Policy declarations in the default graph, and reveal Recipe-enriched details when the user clicks a node. Both layers belong in the first version.

- The default graph communicates structure using step identities, types, binding names, and declared expressions as appropriate to the node. Recipe configuration does not replace the Policy declaration in the graph.
- Clicking a node reveals its declaration and relevant experiment-specific details, including the effective plugin binding and configuration where applicable. Only details relevant to that node need to be shown; not every node represents a plugin call.
- Effective bindings and configuration must account for Policy defaults and Recipe overrides. Policy defaults alone must not be labeled as the experiment's effective configuration.
- Configuration details remain static information. A configured iteration limit is not an observed iteration count, and inputs that depend on runtime state or earlier step outputs must not be presented as known runtime values.

The graph structure can be derived independently of Recipe enrichment. Details use the right-side panel specified in Decision 10 and the saved definition specified in Decision 11. Node-detail content is specified below; static expressions are inspected without evaluation under Decision 20.

## Agreed node granularity

Decision 4: Represent every declared Policy step explicitly in the flow view. Cover all seven supported step types: `invoke`, `state`, `if`, `foreach`, `loop`, `control`, and `reflection`.

State updates and control steps are part of the visible structure, rather than details available only inside plugin-call nodes. Each step must be identifiable in its containing scope and traceable to its declaration; identical local step IDs in different scopes must remain distinguishable.

Every child step remains accessible by expanding its parent, as specified in the default expansion decision below.

## Agreed compound-step presentation

Decision 5: Use nested containers in the flow view to represent compound steps and preserve the Policy's declared hierarchy.

- A `loop` container encloses its declared body.
- A `foreach` container encloses the per-item body. The static structure represents that body once, without creating nodes for actual items or execution instances.
- An `if` container separates the declared `then` and `else` regions. Both declared branches belong to the structure; displaying them does not assert that either branch executed.
- Compound steps can contain further compound steps, preserving their scopes rather than flattening all steps onto one level.

Container headers identify the owning step and its type. Their declaration and relevant configuration are available through the same node-detail interaction as other steps. Layout direction follows Decision 17; edge routing must be verified with the selected layout engine.

## Agreed default expansion

Decision 6: Initially show only top-level steps in the flow view, with compound-step containers collapsed. Users expand containers progressively to inspect their immediate children; nested containers initially remain collapsed until expanded in turn.

Each compound step provides a separate expand/collapse control. Clicking the step or its header opens its declaration and Recipe-enriched details; it does not also toggle expansion. Containers support manual expansion and collapse without changing the Policy declaration or configuration.

Collapsed containers still identify their owning step and type. Their children remain part of the structural model even while hidden, preserving complete step coverage. The implementation specification retains expansion during in-page view switches; longer-term persistence and bulk controls are not required.

## Agreed flow and data views

Decision 7: Provide separate flow and data views within the Policy visualization. Data relationships belong in their own graph rather than an optional overlay of dependency edges on the flow graph.

- The flow view uses edges for declared sequence and control flow only. Its nested containers and progressive expansion follow Decisions 4–6. Data references remain inspectable in node details without adding data-dependency edges to this view.
- The data view uses a graph to express declared data relationships. It remains a static view derived from declarations, not observed runtime values or artifact lineage from an execution.
- Both views describe the same Policy version. A dependency is not evidence that a particular branch ran or that a value was produced in an actual experiment.

Cross-view navigation follows Decision 13. The flow view's nesting and default expansion do not automatically prescribe the data graph's layout.

## Agreed data-view scope

Decision 8: Include Policy input, configuration, shared state, and final output alongside dependencies between step outputs and their consumers.

- Show declared references from Policy input and configuration to their consumers.
- Show declared references from step outputs to other steps and to the Policy's final output.
- Distinguish shared-state reads from writes: a reading step depends on a state field, while a writing step updates that field. Preserve references used in the initial state and update expressions.
- Include the declared sources of the Policy's final output so that users can follow relationships from inputs through processing to the returned result.

These relationships describe references in declarations. Connecting writers and readers through a shared-state field does not establish which write supplies a particular read during execution. Branch-dependent writes, loop iterations, and runtime values remain outside the static view's claims.

Application and scoped local sources follow Decision 21, compound-output mappings follow Decision 22, and the analysis rules below define their extraction.

## Agreed data-node granularity

Decision 9: Use grouped nodes with field-level connections in the data view, rather than making each data field an independent node.

- Represent Policy input, configuration, shared state, and final output as grouped nodes with identifiable fields inside them. For example, `state` contains `bestCandidate` and `bestMeasurement`.
- Represent each participating step as a node with identifiable input and output fields or expression locations. Connections identify the source and consumer fields, rather than expressing only an undifferentiated step-to-step dependency.
- Shared-state read and write connections attach to the corresponding state fields. A shared-state node groups those relationships without asserting a runtime value or a particular writer-to-reader execution path.
- Keep scoped step identities distinct, consistent with the flow view. Grouping must not merge steps merely because they use the same local ID.

Whole-object references and dynamically indexed expressions must retain their declared reference granularity rather than inventing precise field paths. Dynamic access follows Decision 12 below; the response specification selects relationship-bearing fields, with model-size limits to be measured during implementation. This decision does not require all fields declared in every Schema to appear in the initial graph.

## Agreed detail presentation

Decision 10: Display clicked-node details in a right-side panel while keeping the graph visible. Use this presentation in both the flow and data views.

Selecting another node updates the panel to that node's declaration and relevant Recipe-enriched information. Plugin-call details include the applicable effective binding and configuration; other node types show the declaration and configuration relevant to their role. The panel must not imply that every node has a plugin binding.

Opening details does not expand the node inline or toggle its container. Container expansion remains a separate interaction under Decision 6; switching views may reveal a selected step as specified in Decision 13. The implementation specification defines node-detail content; narrow-screen adaptation requires browser verification.

## Agreed declaration source

Decision 11: Use the experiment's saved Policy and Recipe definition snapshot, rather than current local source files.

The existing definition lock, which contains the serialized Policy and normalized Recipe, is the intended source. The flow graph, data graph, and detail panel must use the same saved definition. Recipe-enriched details describe the bindings and configuration in that snapshot, not an assertion about later runtime activation.

Local edits after the snapshot was saved must not change the visualization. Identify the saved Policy and definition version in the view. Do not silently substitute current files when a saved definition is unavailable. The read path is specified below, and unavailable results follow Decision 19. Subsequent revision browsing is outside the first version, as confirmed in Decision 16.

## Agreed dynamic-reference presentation

Decision 12: Retain data-dependency edges for dynamically indexed references. Connect them at the object or collection boundary that can be determined statically, and label the access as dynamic.

For example, `input.items[loop.index]` connects the known `input.items` collection to the consuming expression location. It does not select a specific element or expand actual iterations. The detail panel preserves the complete expression, including its index expression, so that the reason for the less precise connection remains inspectable.

Do not omit a known dependency solely because its final field or element cannot be resolved statically. Do not guess a concrete field or evaluate the Policy to obtain one. Whole-object references retain object-level precision and are not automatically labeled dynamic merely because they refer to an object.

Index-expression dependencies follow Decision 21. Label styling is a rendering detail and must retain an explicit dynamic-access indication.

## Agreed cross-view navigation

Decision 13: Preserve the selected step and locate its corresponding node when switching between flow and data views.

Use the step's scoped identity within the saved definition to match nodes, rather than its label or local ID alone. When the destination flow node is hidden inside collapsed containers, expand the necessary ancestors and bring the node into view. This targeted reveal is an exception to the initial top-level-only presentation, not a request to expand unrelated containers.

The right-side panel continues to describe the corresponding selected step after the switch. This behavior applies only where both graphs have a corresponding step node. Data-only groups such as configuration and shared state must not be mapped to an unrelated flow step. The implementation specification below clears the destination selection when no counterpart exists.

## Agreed data-view initial extent

Decision 14: Default to the selected step's direct data relationships, with an option to show the full dependency graph. If no step is selected, show the full graph.

The focused view includes the selected step, its directly referenced sources, and its direct consumers or write targets, retaining field-level connections and dynamic-reference labels. Do not recursively expand all transitive relationships by default. In particular, reading a shared-state field does not automatically include every writer of that field as a direct producer for the selected step.

Provide an explicit way to switch between focused and full views. When a corresponding step is selected through cross-view navigation, use it as the focus. Filtering changes only which relationships are displayed; it does not remove them from the underlying model. The implementation specification below retains graph extent when selecting a data-only group.

## Agreed analysis and rendering boundary

Decision 15: Perform static structural analysis on the backend and return a serializable semantic model through an observation query. Read the saved definition, reuse the Runtime's existing expression parsing and scope semantics, and derive step hierarchy, control-flow relationships, and data references without executing the Policy or its plugins.

The frontend consumes that model and owns layout, drawing, expansion, selection, view switching, and filtering. Keep coordinates and other layout choices out of the semantic analysis. Node details use the same saved definition and the existing redaction boundary.

This responsibility split is agreed. Decision 18 defines the response boundary; module ownership, response sections, and extraction rules are specified below. No analysis or rendering implementation has been added.

## Agreed revision boundary

Decision 16: Keep the first version anchored to the saved initial definition. Display the declared `reflection` step as part of the flow, while leaving inspection of subsequent plugin-resource revisions to the existing Reflection & Memory view. Do not add revision switching to the Policy visualization in the first version.

Node details describe the initial snapshot's configuration and resource references. They must not be labeled as the currently activated configuration or resources after Reflection. This boundary does not remove Reflection steps from the flow or introduce runtime execution overlays.

## Agreed layout directions

Decision 17: Lay out the flow view primarily from top to bottom and the data view primarily from left to right.

The flow direction supports reading declared sequence within nested containers. The data direction supports following sources, processing steps, and consumers through field-level connections. These are presentation directions, not additional execution or dependency semantics. Feedback relationships through shared state may form cycles; a left-to-right layout must not suppress or reverse those edges to imply an acyclic graph.

The frontend owns layout under Decision 15. Branch placement, edge routing, and viewport behavior remain implementation details to specify; this decision does not select a rendering library or require a user-facing direction toggle.

## Agreed observation response

Decision 18: Use a single read-only endpoint to supply the complete semantic model for both views from the initial saved definition. The proposed route is `GET /api/observation/experiments/:id/policy-structure`; the exact route name remains an implementation detail.

The response contains source identity, scoped step hierarchy, flow relationships, grouped data nodes and field-level dependencies, and the redacted declaration/configuration details needed by the side panel. Shared binding details should be referenced rather than copied into every invocation node. File or directory resource contents are not automatically embedded in this response.

The frontend loads this model when entering the Policy tab, then performs expansion, focused/full graph filtering, selection, and view switching locally. A collapsed node does not require another analysis request. The response contains no layout coordinates or runtime execution overlays.

The normal response covers the complete declaration graph, not just the currently visible or focused subset. Incomplete-analysis handling follows Decision 19. Response sections are specified below; exact types and measured size bounds are implementation validation items. No endpoint has been implemented.

## Agreed incomplete-analysis behavior

Decision 19: Keep independently reliable results visible when a specific part of static analysis is unavailable. For example, a readable and structurally supported saved definition may still provide its flow graph if a data expression cannot be analyzed by the visualization analyzer. Clearly mark the affected data view or node as incomplete and identify the affected declaration location; missing analysis must not look like an absence of dependencies.

Only isolate failures when their scope is known. If the analyzer cannot establish the scope of an error, report the affected view as unavailable rather than returning an apparently complete partial graph. A missing or invalid saved definition makes the visualization unavailable; it does not trigger a fallback to current local files. Dynamically indexed references supported by Decision 12 are normal analysis results, not failures.

Diagnostics must distinguish analysis failures from missing source information, identify the affected view and declaration location where known, and remain visible when filtering or switching views. A response with partial results must explicitly report its incomplete status. This policy does not permit silently catching arbitrary errors, inventing relationships, or treating an incomplete response as successful full analysis.

## Agreed static-dependency rule

Decision 20: Extract references from all expression branches without evaluating conditions against Recipe values or runtime state. A dependency means that the declaration references a source; it does not mean that a particular execution must read it.

For example, the illustrative expression `if(config.useCached, input.cached, steps.evaluate.output.value)` references the condition and both possible value sources. Preserve all three dependencies even when the saved configuration contains a value for `useCached`. Apply the same principle to conditional expressions and short-circuit operators. Recipe enrichment remains contextual information in details and does not prune the declaration graph.

The existing expression AST and reference traversal provide a starting point for this rule. Dependency extraction still needs to preserve consumer locations, scoped identities, and dynamic-access precision, rather than treating the existing path list as a complete visualization model.

## Agreed remaining data sources

Decision 21: Represent Application values and scoped loop variables explicitly as data sources when referenced, using the same grouped-node and field-level connection approach as other sources.

- An `application` group exposes referenced fields such as `initialCandidate`. It represents the declared source, not a claim to know the candidate reference produced at runtime.
- A loop-scope context group exposes `loop.index` where it is in scope.
- A `foreach` item-scope context group exposes the declared item variable and referenced fields. Connect its item source to the collection expression using a symbolic per-item relationship, without enumerating concrete items.
- Identify each local context by its declaring scope. Nested loops or repeated item variable names must not be merged into one global source.

Analyze references inside index expressions as well as references to the indexed object. For `input.items[loop.index]`, this preserves the dynamic collection access and the dependency on the correct loop scope's index. The analyzer should follow the existing scope rules in the [compiler](../../../src/runtime/compiler/scope.ts) and [step implementations](../../../src/runtime/policy/steps.ts).

This completes source coverage without expanding runtime iterations. It does not introduce candidate/measurement execution records or require actual values for these sources.

## Agreed compound-output representation

Decision 22: Preserve compound steps as data nodes with explicit output fields when their results are consumed. Show how declared block outputs map to those fields instead of flattening internal producers into direct edges to external consumers.

- For `if`, preserve the `then` and `else` output mappings separately and label their branch origins. Both mappings remain visible as declared alternatives, not simultaneously produced values.
- For `foreach`, represent the per-item output mapping and the resulting collection symbolically. External references target the compound step's collection output; do not enumerate elements or imply that the collection is one item's scalar result.
- For `loop`, derive output dependencies from its declared output expression in the enclosing scope, as the Runtime does. Do not connect the final body step automatically to the loop result. Shared-state reads and writes continue to pass through their state fields without asserting which iteration supplied the value.

For example, an illustrative branch output mapping produces the path `evaluate_candidate.output.measurementRef → choose.output.measurementRef → select`. A direct outer-scope reference used inside a block remains a direct declared reference; it does not need a fabricated compound input. This preserves explicit result boundaries without rerouting every cross-scope relationship through a container.

The rules follow the current [compound-step implementations](../../../src/runtime/policy/steps.ts). No graph extraction has been implemented or tested.

## First-version implementation specification

The following specification translates the agreed decisions into the accepted implementation baseline. It defines required behavior and ownership; it does not claim implemented capabilities or completed verification.

### Ownership and read path

| Layer                                      | Responsibility                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/observation.ts`             | Define the read-only structure response and diagnostics, without renderer-specific types. Split into an adjacent focused contract module only if needed for size.                  |
| `src/runtime/compiler/policy-structure.ts` | Own pure static projection from a validated saved declaration into hierarchy, control relationships, and data dependencies. Reuse the existing expression AST and scope semantics. |
| `src/runtime/services/observation.ts`      | Read the experiment's saved definition through the FactStore, validate the persisted boundary, invoke projection, and redact the response.                                         |
| `src/entries/web/observation.ts`           | Register the single GET route and validate the experiment ID using existing route conventions.                                                                                     |
| `web/api/observation-client.ts`            | Validate the response at the client boundary.                                                                                                                                      |
| `web/features/experiments/`                | Own the Policy view, graph adaptation, layout, selection, filtering, and detail panel.                                                                                             |

The [Manager](../../../src/runtime/manager/index.ts) stores and reads the lock under `definitions` keyed by experiment ID. The observation query uses that saved record; it does not call resume, restore resources, execute plugins, load current Policy files, or write facts. Validate the supported lock version and digest through storage/definition-lock ownership before trusting its contents. No new public plugin is needed.

### Response shape

Use one response containing the following conceptual sections; exact TypeScript names can follow implementation conventions.

| Section          | Content                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Source           | Experiment ID, Policy ID, saved-definition digest, and an explicit initial-snapshot designation.                         |
| Availability     | Overall and per-view completeness, distinguishing complete, partial, and unavailable results.                            |
| Steps and scopes | Stable identifiers, step type, declaration location, parent scope, and ordered child regions.                            |
| Flow             | Typed sequence, branch, repetition, and explicit control-transfer relationships.                                         |
| Data             | Grouped nodes, field/expression ports, and typed reference, state-write, item-binding, and output-mapping relationships. |
| Details          | Redacted declaration fragments and saved configuration/binding context, shared by reference where appropriate.           |
| Diagnostics      | Failure or missing-data category, affected view, scoped node/declaration location where known, and a safe explanation.   |

Node identity combines the saved-definition identity with an unambiguous structural declaration path. Use structured path segments or escaped JSON Pointers; labels and runtime iteration paths are not identities. Ports identify a source field or a consumer's declaration location. Scalar and whole-object outputs need valid endpoints even when no named child field exists. Each edge retains the declaration location that establishes it.

Keep initial data-node field lists limited to fields used by relationships or required for their output mappings. Full declarations remain inspectable in details. Omitted unused Schema fields do not imply missing analysis. Do not silently truncate nodes or edges to meet a response bound; reject an oversized model explicitly. Choose concrete bounds after measuring built-in declarations and document those limits before implementation acceptance.

### Analysis rules

1. Traverse declared blocks and assign scoped identities before resolving references. Match the compiler's lexical visibility rules, including completed outer steps and local variable boundaries.
2. Inspect expression-bearing templates, including step inputs, conditions, loop bounds, collection/key/concurrency expressions, initial state, state updates, input defaults, and block/Policy outputs. Do not scan arbitrary plugin configuration strings as if they were Policy expressions.
3. Walk the existing AST without evaluation. Preserve static field paths, whole-object access, dynamic boundaries, and index-expression dependencies. Resolve `steps.<id>.output` to the correct declaration scope; do not connect by a globally repeated step name.
4. Distinguish argument references from output mappings and shared-state writes. Do not invent internal field lineage through opaque plugin implementations. For example, a reference into an invocation's input does not prove a field-level transformation into a particular output field.
5. Preserve compound-output mappings under Decision 22. Keep conditions and alternatives without pruning. Initialize state through its declaration; show subsequent writes without selecting a last writer or simulating iterations.
6. Emit scoped diagnostics when a supported projection cannot be produced. A missing reference target is not converted into an invented producer. Whole-view failures follow Decision 19 when isolation cannot be established.

### Flow and interaction details

Normal sequence follows declared block order. Branch edges identify `then` and `else`; empty branches remain expressible. Loop and collection bodies are symbolic regions. A `foreach` header shows its declared concurrency setting or expression without drawing worker instances or assuming an evaluated value.

Explicit `break` and `continue` target the nearest permitted loop exit or continuation boundary; they cannot cross a `foreach` boundary under current Runtime rules. `fail` targets a failure terminus. Do not draw normal fall-through from an unconditional control-transfer node. Synthetic entry/exit anchors are presentation aids, not invented executable Policy steps.

Initially open the flow view. Retain view-local pan/zoom and expansion state during switches in the mounted Policy page, except for targeted reveal of a corresponding selected step. Provide pan, zoom, fit-to-view, and the agreed focused/full data toggle. Node selection opens the shared panel; container toggle buttons remain separate and keyboard accessible.

If a selected node has no counterpart, switch views without selecting an unrelated node and clear the destination panel. Selecting a data-only group keeps the current graph extent and shows its details; step-focused mode is anchored to steps. Keep incomplete-analysis indicators visible in both focused and full modes. Resource references remain references rather than automatically loading file contents.

The detail panel identifies the node, its scope, and saved definition. Show applicable declaration fields and the corresponding saved configuration separately, preserving expression text instead of presenting an evaluated result.

| Node kind    | Relevant detail content                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | Binding name, required contract, saved effective plugin/configuration, declared input template, and referenced output fields.                                                   |
| `state`      | Declared state-update expressions and affected state fields.                                                                                                                    |
| `if`         | Condition and separate branch output mappings.                                                                                                                                  |
| `loop`       | Declared limit, condition, and output template, with separately identified referenced configuration values.                                                                     |
| `foreach`    | Collection expression, item variable, key, concurrency declaration, and per-item output mapping.                                                                                |
| `control`    | Action, its structural target, and declared failure reason where applicable.                                                                                                    |
| `reflection` | Step declaration and the initial saved Reflection configuration where available, without later revision content.                                                                |
| Data groups  | Referenced field paths, declaration/default expressions or saved configuration as applicable, scope ownership, and connected relationships. Runtime-only values remain unknown. |

All node kinds also show relevant missing-data or analysis diagnostics. Details expose the saved declaration fragment for inspection; they do not fetch current source files.

The rendering library and layout engine remain implementation choices. Before adopting either, verify nested containers, field ports, cyclic data relationships, and selection preservation against this specification. No dependency addition or browser prototype is part of the current documentation task.

## Agreed acceptance criteria

Decision 23: Accept the implementation through deterministic semantic and API tests, browser verification, and the repository's existing checks. Acceptance concerns static visualization correctness and usability. It does not require a model request, a real evaluation run, or evidence of Online Evolve taking effect.

| Area                    | Required evidence                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic coverage       | Deterministic fixtures cover all seven step types, nested scopes with repeated local IDs, empty branches, compound output boundaries, state reads/writes, and explicit control transfers.                                                                            |
| Data dependencies       | Fixtures verify all expression branches, Application and local sources, collection outputs, scalar/whole-object references, and dynamic access including index dependencies. No fabricated precise fields, execution values, or plugin-internal lineage.             |
| Saved source            | An API test reads a saved definition and proves that later local source edits do not alter the model. Missing, unsupported, and invalid locks have explicit outcomes; reads do not mutate facts or restore resources.                                                |
| Reliability and privacy | Tests distinguish complete, partial, and unavailable results; verify diagnostic locations and redaction in details, labels, expressions, and errors; ensure no partial graph is reported as complete.                                                                |
| Browser behavior        | Verify initial folding, independent detail/expand actions, both directions, field connections, cross-view reveal, focused/full switching, empty states, and visible incomplete-analysis indicators. Exercise wide and narrow layouts and keyboard access.            |
| Representative size     | Inspect a small fixture and existing parameter-grid and Harness² declarations, loading definitions without executing them. Verify readable nested layouts and absence of clipped details or unusable navigation; record actual model size and layout responsiveness. |
| Repository checks       | Run the existing `pnpm check` for implementation changes and the focused API/browser checks above. Report actual results and any unavailable environment separately.                                                                                                 |

Tests use temporary stores and deterministic local fixtures. They must not depend on a developer's existing `.rsi/` history or live credentials. These criteria are agreed future verification work, not checks already performed.

## Architectural constraints

- Preserve the Runtime as the owner of Policy validation and execution semantics. Do not introduce a second DSL compiler in the browser.
- Deliver visualization data through public management/query interfaces. The UI does not inject core state or execute plugins to discover structure.
- Distinguish the declaration being displayed from observed execution. An experiment view must identify its source/version rather than silently substituting a currently edited local Policy file.
- Preserve the existing observation boundary for redacting sensitive configuration when defining any new response.

The response structure and ownership are specified above. Exact TypeScript type names, rendering-library selection, and layout-algorithm selection do not change the agreed semantics.

## Implementation choices requiring evidence

- Select the rendering library and layout engine after verifying nested containers, field ports, cycles, and cross-view selection. This document does not claim those capabilities have been tested.
- Measure representative declaration sizes before setting response and layout bounds. Report oversized inputs explicitly rather than silently truncating a graph. Record the chosen limits before implementation acceptance.
- Finalize response types and route naming alongside their callers and tests. Preserve the single read-only response, completeness diagnostics, and saved-definition identity.
- Validate narrow-screen layout and routing of long or crossing edges in the browser. Desktop uses the agreed right-side panel; narrower layouts must preserve access to graph context and details.

These are implementation validation items, not reasons to change the agreed first-version scope or introduce additional features. Long-term viewport persistence and bulk expansion controls are not required by this design.

## Final review and acceptance

The final review on 2026-11-12 compared the design with the current compiler, expression AST, step implementations, definition lock, Recipe and binding loaders, observation boundary, and experiment view. No blocking design issue was identified. Decisions 1–23 and the implementation specification are accepted as version 1 under the user's instruction to finalize the draft if the review found no issue.

Implementation should follow this specification. Renderer and layout selection, measured resource limits, exact response types, and route naming remain the bounded implementation choices listed above; they do not reopen the agreed scope. This acceptance records a source-based design review, not implementation acceptance.

## Verification and implementation status

Repository source and documentation were inspected. The finalized design document passed a direct check with the repository-installed Prettier and a local relative-link existence check. Its encoding, line endings, final newline, and decision numbering were also checked. No application code or public interfaces have been changed, no rendering approach has been prototyped, and no runtime or browser tests have been executed for this design. Implementation acceptance criteria remain unexecuted.

Version 1 is finalized. Implementation and its acceptance checks remain future work. No commit, push, or implementation has been performed for this design task.
