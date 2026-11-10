# Single-file and multi-file operator candidates

Status: proposed for review on 2026-11-10. Implementation and acceptance are pending.

## Configuration and ownership

The [kernel Application](../../../src/plugins/application-kernel/schema.ts) currently derives one source path from a file Target. The [SDK adapter](../../../src/plugins/evaluator-operatorbench/kernel-input.ts) stages its bytes as `input.py`. The proposed configuration gives the Application one entry file and an explicit, fixed list of candidate-local Python dependencies. The existing Target continues to authorize changes. The exported Python callable remains `kernel_function`.

```yaml
application:
  plugin: application.kernel
  config:
    baseline: { directory: ./baseline }
    target: { schema: ./target.yaml }
    source:
      entryFile: kernels/kernel.py
      dependencies:
        - kernels/__init__.py
        - kernels/tiling.py
```

For this example, the Target can authorize only `modify` on `kernels/tiling.py`. The proposer can read all three source files. Installed libraries such as torch and Triton belong to the execution environment. Authors list local package initializers and helper modules needed by their code.

When `source` is absent, use the current unique Target file as the entry with no dependencies. An ambiguous Target must supply an explicit entry. With `source` present, the entry may be read-only. Paths are normalized relative to the candidate root. Reject duplicates, an entry repeated as a dependency, escapes, symlinks, missing members and invalid UTF-8 before recording the candidate. Keep the declared file set fixed through an experiment. Edits can change the contents of authorized members. Supporting changes to package membership would require a separate decision.

## RSI changes

1. The Application resolves the layout once. Expose its path-only layout to the Proposer through an optional field on the initialize result for capability metadata, projected by the existing `context.applicationMetadata()`. Only the kernel capability needs to populate it. The Runtime transports this JSON. The Application owns its interpretation. Older initialization records can use the existing single-file Target rule.
2. On acquisition, keep `sourcePath` and the existing entry-byte `sourceDigest`. Include the declared files and their SHA-256 digests plus a `sourceBundleDigest` over the entry path and a path-sorted list of relative paths and byte hashes. Use the repository's canonical JSON digest. Keep `artifactRef` as the identity of the complete candidate artifact.
3. The Proposer reads the declared files from the frozen candidate artifact, exposes them under a dedicated source snapshot directory, and uses exact candidate-relative paths in model responses. Reuse Target matching and protected-path rules to obtain the editable subset. Allow one response to update several authorized files subject to Target and call budgets. Validate the whole edit set before applying it in one workspace and committing one candidate. Keep single-file responses compatible. Bind analyses and history for new multi-file candidates to the bundle digest.
4. The RSI adapter stages the candidate under a separate candidate directory, preserving relative paths. Stage the reference separately. Verify every staged candidate member against the acquired descriptor and check the SDK source lock against the staged inventory before accepting a result. Keep the SDK's entry SHA and the reference hash checks. A diagnostic assessment must match the candidate, bundle, task, case, seed and environment before its evidence is reused.

## Evaluator changes and comparison semantics

Reuse the existing manifest fields `candidate` and `files` for the entry and dependencies. Carry the candidate import root to precision, timing and profiling workers, using an optional manifest field if needed to distinguish it from the reference root. All workers must load the same frozen tree with the same package structure. Profiling a staged package must retain that structure instead of copying the entry alone to `candidate_staged.py`. An SDK-internal single-file alias can continue to serve historical flat inputs.

Bind replay and any enabled profile cache to the full source inventory as well as reference, device and capture protocol. Independent profiling continues to require fresh evidence. Check the projected inventory and its hashes even when only a helper changed.

Keep two identities separate in the Measurement. Candidate provenance includes every source member, including editable helpers. Fixed comparison conditions include the task, reference, device, SDK, measurement protocol, declared layout and read-only source hashes. Exclude the actual contents of editable candidate files from the comparison key. Thus a helper-only edit changes candidate identity and invalidates prior evidence while retaining comparability against the incumbent. Use the same Target authorization when classifying editable files for proposal and comparison.

## Compatibility, rollout and acceptance

Read historical single-file measurements under their original semantics. A historical assessment with only an entry digest cannot certify a multi-file candidate. Keep the existing compatibility path for historical single-file leases. The SDK extension is additive for existing manifests. A multi-file request requires a compatible installed SDK and should fail clearly with an older one. Verify the packaged SDK with RSI before updating its dependency pin to an available revision.

The primary acceptance scenario uses the configuration above. Change only `tiling.py`, verify the entry bytes are identical, the bundle digests differ and the two measurements have the same comparison key. Precision, timing and profiling must import the new helper. Reusing the old assessment or cached capture must fail. Confirm that an attempted change to the read-only entry, including a mixed authorized/unauthorized response, creates no candidate.

Also cover an existing `input.py` Recipe, a renamed nested single file, legacy receipts, relative and candidate-root imports, missing or changed helpers, duplicate or escaping paths, and a candidate filename colliding with the reference basename. Run the existing repository checks and an installed-consumer integration. Worker fixtures establish loading, authorization and evidence identity. Real Ascend correctness and latency require a separate device run.
