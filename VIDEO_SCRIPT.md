# Memnora demo video script

## Memory architecture

> I built a web-search agent that treats memory as managed data rather than unlimited prompt context. It extracts compact notes asynchronously, resolves duplicates and updates, tracks volatile facts for re-checking, supports explicit forgetting, and retrieves only a small amount of attributable context. I benchmarked both the strengths and the remaining semantic-recall gap.

Show the following while delivering this section:

1. Ask a question in one chat, then recall or summarize it from another chat.
2. Expand **Sources & context** to show the exact memory notes used.
3. Re-check a volatile fact to demonstrate fresh search and comparison with the stored snapshot.
4. Briefly show the memory benchmark: 100% exact and lexical recall, 50% semantic-paraphrase recall, zero unrelated-query false positives, and 95% context reduction on the current synthetic evaluation.

## Future direction

> The measured semantic-recall gap gives the project a clear next step: hybrid document memory. Memnora can keep fast SQLite full-text search as its first layer, add embeddings for paraphrases, and ingest cited document chunks through the same relevance, provenance, resolution, and forgetting lifecycle. That remains internal memory, so web search is still the agent's only tool.

Present this as the next stage, not as functionality that is already shipped.
