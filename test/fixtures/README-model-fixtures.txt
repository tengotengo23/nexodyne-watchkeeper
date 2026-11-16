Model picker fixtures, trimmed by hand from the real Claude Code 2.1.310 samples of 16 Nov 2026:
- model-missing.json, model-missing.ndjson: a model that does not exist (claude-nonexistent-9): exit 1, is_error true,
  api_error_status 404, subtype "success", a "<synthetic>" assistant message with the same text. The fakes put the asked id in.
- model-ok-fable-5-2.json and model-ok-fable-5-2.stderr.txt: --model claude-fable-5-2 works (exit 0) and still prints the
  [claude-code:unrecognized_model] tag on stderr, so stderr is never a failure signal. The result text was cut to "ok".
- model-busy.json (429) and model-overloaded.json (529) are CONSTRUCTED, not captured: the fields match the 404 sample's shape.
