import test from "node:test";
import assert from "node:assert/strict";

import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

// #10865: the Endpoint page persists the custom system prompt via
// PATCH /api/settings, but updateSettingsSchema lacked the two fields, so Zod
// stripped them and the toggle/text reset on every reload. updateSettings (the
// DB writer) persists any key present in the validated object, so accepting the
// fields in the schema is the complete fix.

test("customSystemPromptEnabled is accepted and preserved by the settings PATCH schema", () => {
  for (const customSystemPromptEnabled of [true, false]) {
    const validation = updateSettingsSchema.safeParse({ customSystemPromptEnabled });
    assert.equal(validation.success, true);
    if (!validation.success) continue;
    assert.equal(validation.data.customSystemPromptEnabled, customSystemPromptEnabled);
  }
});

test("customSystemPrompt text is accepted and preserved by the settings PATCH schema", () => {
  const prompt = "You are a concise assistant. Always answer in one paragraph.";
  const validation = updateSettingsSchema.safeParse({ customSystemPrompt: prompt });
  assert.equal(validation.success, true);
  if (!validation.success) return;
  assert.equal(validation.data.customSystemPrompt, prompt);
});

test("both custom-system-prompt fields survive a combined PATCH (regression for #10865)", () => {
  const payload = {
    customSystemPromptEnabled: true,
    customSystemPrompt: "Persisted prompt.",
  };
  const validation = updateSettingsSchema.safeParse(payload);
  assert.equal(validation.success, true);
  if (!validation.success) return;
  // Both keys must survive validation so updateSettings can write them.
  assert.deepEqual(
    {
      customSystemPromptEnabled: validation.data.customSystemPromptEnabled,
      customSystemPrompt: validation.data.customSystemPrompt,
    },
    payload
  );
});

test("customSystemPromptEnabled rejects non-boolean values", () => {
  const validation = updateSettingsSchema.safeParse({ customSystemPromptEnabled: "true" });
  assert.equal(validation.success, false);
});

test("customSystemPrompt rejects non-string values", () => {
  const validation = updateSettingsSchema.safeParse({ customSystemPrompt: 123 });
  assert.equal(validation.success, false);
});
