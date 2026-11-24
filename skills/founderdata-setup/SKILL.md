---
name: founderdata-setup
description: Set up FounderData with the owner. Deploy it, add the sites and apps, install the tracker or SDK, connect payments, and check each step by its real signal with get_setup. Use when asked to set up, install or finish setting up FounderData.
---

# Set up FounderData

Placeholder written by the API worker so the prompt bundle has a skill to test. The skills worker's version replaces it.

1. Call `get_setup`, or `GET /api/v1/setup`.
2. Do what `next.prompt` says. `next.who` says who acts.
3. Call `get_setup` again and check that the step is `done`. Repeat until `next` is null.
