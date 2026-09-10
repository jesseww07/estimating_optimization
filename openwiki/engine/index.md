# Files

- [Accuracy Eval Harness](eval-harness.md) - How the VE engine's substitution accuracy is measured against labeled historical outcomes (leave-one-project-out replay), the metrics it reports, and the CI regression ratchet that enforces it on every PR.
- [Recommendation Engine](recommendation-engine.md) - How analyzeLineItem scores, ranks, and gates VE substitution recommendations against Premier's catalogs and estimator History, including the Phase 4 family/series matching, the null-category junk gate, the learned series→category map, the 3rd-party earn-your-slot rule, and the exact-history confidence/auto-select-eligibility rework.
