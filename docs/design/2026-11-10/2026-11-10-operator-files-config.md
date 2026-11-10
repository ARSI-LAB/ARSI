# Operator file configuration amendment

This supplements [the source-file design](2026-11-10-operator-source-files.md) with the configuration approved on 2026-11-10. Extend the existing `application.kernel` implementation and shared file Application lifecycle. Use direct configuration fields, without a `source` wrapper.

```yaml
application:
  plugin: application.kernel
  config:
    baseline: { directory: ./baseline }
    target: { schema: ./target.yaml }
    entryFile: kernels/kernel.py
    additionalFiles:
      - kernels/__init__.py
      - kernels/tiling.py
```

`entryFile` identifies the module exporting `kernel_function`. `additionalFiles` enumerates candidate-local dependencies, including required package initializers. Installed libraries remain environment dependencies. Supplying `additionalFiles` requires an explicit `entryFile`; omitting both keeps the unique Target file as the entry. The Target independently authorizes modifications to the declared source files. The entry can be read-only, and the file inventory stays fixed during an experiment.

The Application publishes the path-only layout in initialize `capabilityMetadata.kernel-source`. Acquisition includes `sourceFiles`, the entry-byte `sourceDigest` and the complete `sourceBundleDigest`. Legacy single-file leases are normalized on reading. Analysis identities retain their entry digest and additionally require the bundle digest for multi-file candidates.

Multi-file SDK manifests use `candidateRoot: candidate`, with `candidate` and `files` preserving candidate-relative paths under that root. The reference is staged separately. Single-file candidates retain the historical internal SDK alias. Comparison conditions include the declared layout and read-only source hashes, and exclude editable source contents. Candidate provenance and profile cache identity cover all source members.

Implementation and verification results are reported with the implementation delivery. Actual NPU correctness and performance require device validation.
