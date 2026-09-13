import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult rejects incomplete review JSON instead of normalizing it", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine.",
        findings: null,
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine.",
        findings: null
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult rejects unknown verdicts and extra top-level fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "maybe",
        summary: "Looks fine.",
        findings: [],
        next_steps: [],
        extra: true
      },
      rawOutput: '{"verdict":"maybe","summary":"Looks fine.","findings":[],"next_steps":[],"extra":true}',
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /unexpected review shape/);
  assert.match(output, /Unexpected top-level review field/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
