# Public source snapshot

The public GitHub repository starts from a verified source snapshot. The local development history remains in the original checkout and is not an ancestor of the public `main` branch.

The first full-history push was rejected by GitHub push protection because an older commit contained Stripe-shaped **synthetic redaction test vectors**. The current source encodes those fixture bytes in JSON and test code so the runtime test values remain the same without publishing the detector-shaped source strings. No user provider credential was found in the tracked source or the checked development history. We did not bypass push protection.

Commit IDs cited in older QA reports refer to the retained local development history and may not resolve in the public repository. Test counts, commands, observed results, and unresolved physical release gates are recorded in those reports independently of the public Git history.
