import { test } from "node:test";
import assert from "node:assert/strict";
import serverArchitect, { planToSteps } from "../src/tools/serverArchitect.js";

/**
 * `planToSteps` is the pure heart of the architect: it turns a declarative plan
 * into the ordered, idempotent step list that both the preview and the apply use.
 * Testing it directly pins the ordering guarantee (roles before channels, because
 * channel overwrites reference role IDs) without touching Discord.
 */

const handler = (name: string) => serverArchitect.handlers.get(name)!;
const definition = (name: string) => serverArchitect.definitions.find((d) => d.name === name)!;

test("the architect exposes planning, reading, applying, repairing and limits tools", () => {
  const names = serverArchitect.definitions.map((d) => d.name);
  for (const expected of [
    "discord_architect_plan",
    "discord_architect_read_structure",
    "discord_architect_compare",
    "discord_architect_apply",
    "discord_architect_repair",
    "discord_architect_explain_limits",
    "discord_architect_create_template",
    "discord_architect_list_templates",
    "discord_architect_delete_template",
    "discord_architect_delete_structure",
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing from the architect toolset`);
  }
});

test("planToSteps orders roles first, then categories, then their channels", () => {
  const steps = planToSteps({
    theme: "futuristic",
    roles: [
      { key: "dev", name: "Developer" },
      { key: "member", name: "Member" },
    ],
    categories: [
      {
        name: "Accueil",
        channels: [
          { name: "regles", kind: "rules" },
          { name: "annonces", kind: "announcement" },
        ],
      },
    ],
    uncategorized: [{ name: "vocal-general", kind: "voice" }],
    system_channels: {},
  });
  assert.deepEqual(
    steps.map((s) => s.kind),
    ["role", "role", "category", "channel", "channel", "channel"],
  );
  assert.equal(steps[0]!.label, "✦・developer");
  assert.equal(steps[2]!.label, "✦・accueil");
  assert.equal(steps[3]!.label, "✦・regles");
  // The parent is recorded by the *styled* category name, which is what the
  // category step actually creates on Discord.
  assert.equal(steps[3]!.parentName, "✦・accueil");
  assert.equal(steps[5]!.parentName, undefined, "uncategorised channels have no parent");
});

test("planToSteps maps logical channel kinds to the right Discord channel types", () => {
  const steps = planToSteps({
    roles: [],
    categories: [
      {
        name: "Cat",
        channels: [
          { name: "a", kind: "text" },
          { name: "b", kind: "voice" },
          { name: "c", kind: "forum" },
          { name: "d", kind: "announcement" },
          { name: "e", kind: "stage" },
        ],
      },
    ],
    uncategorized: [],
    system_channels: {},
  });
  const types = steps.filter((s) => s.kind === "channel").map((s) => s.payload.type);
  // ChannelType: GuildText=0, GuildVoice=2, GuildCategory=4, GuildAnnouncement=5,
  // GuildStageVoice=13, GuildForum=15
  assert.deepEqual(types, [0, 2, 15, 5, 13]);
});

test("planToSteps emits an explicit category type and parents channels by the styled name", () => {
  // Regression: the category step once carried no `type`, so Discord created a
  // plain text channel instead of a category and every child lost its parent.
  const steps = planToSteps({
    theme: "minimal",
    roles: [],
    categories: [{ name: "Accueil", channels: [{ name: "chat", kind: "text" }] }],
    uncategorized: [],
    system_channels: {},
  });
  const category = steps.find((s) => s.kind === "category")!;
  assert.equal(category.payload.type, 4, "GuildCategory is type 4");
  const child = steps.find((s) => s.kind === "channel")!;
  assert.equal(child.parentName, category.label, "the child must parent by the created name");
});

test("planToSteps without a theme keeps the plain names", () => {
  const steps = planToSteps({
    roles: [],
    categories: [{ name: "General", channels: [{ name: "chat", kind: "text" }] }],
    uncategorized: [],
    system_channels: {},
  });
  assert.equal(steps[0]!.label, "General");
  assert.equal(steps[1]!.label, "chat");
});

test("planToSteps builds stable keys so a re-run can be diffed by key", () => {
  const plan = {
    roles: [{ key: "dev", name: "Dev" }],
    categories: [{ name: "Cat", channels: [{ name: "one", kind: "text" as const }] }],
    uncategorized: [{ name: "lone", kind: "voice" as const }],
    system_channels: {},
  };
  const first = planToSteps(plan).map((s) => s.key);
  const second = planToSteps(plan).map((s) => s.key);
  assert.deepEqual(first, second, "keys must be deterministic");
  assert.deepEqual(first, ["role:dev", "category:Cat", "channel:Cat/one", "channel:/lone"]);
});

test("architect_plan reports unknown role keys referenced by permission lists", async () => {
  const result = await handler("discord_architect_plan")({
    plan: {
      roles: [{ key: "member", name: "Member" }],
      categories: [
        {
          name: "Staff",
          channels: [{ name: "staff-chat", kind: "text", hidden_from: ["ghost"] }],
        },
      ],
      uncategorized: [],
    },
  });
  const problems = (result.structuredContent as { problems: string[] }).problems;
  assert.ok(
    problems.some((p) => /Unknown role key "ghost"/.test(p)),
    `expected an unknown-role-key problem, got ${JSON.stringify(problems)}`,
  );
  assert.ok(!problems.some((p) => p.startsWith("warning:")));
});

test("architect_plan warns about duplicate names and an empty plan", async () => {
  const duplicate = await handler("discord_architect_plan")({
    plan: {
      roles: [],
      categories: [
        { name: "One", channels: [{ name: "chat", kind: "text" }] },
        { name: "Two", channels: [{ name: "chat", kind: "text" }] },
      ],
      uncategorized: [],
    },
  });
  const problems = (duplicate.structuredContent as { problems: string[] }).problems;
  assert.ok(problems.some((p) => p.startsWith("warning:") && /share the name/.test(p)));

  const empty = await handler("discord_architect_plan")({
    plan: { roles: [], categories: [], uncategorized: [] },
  });
  assert.ok(
    (empty.structuredContent as { problems: string[] }).problems.some((p) => /empty/.test(p)),
  );
});

test("architect_plan reports the step count and per-step parentage", async () => {
  const result = await handler("discord_architect_plan")({
    plan: {
      roles: [{ key: "dev", name: "Dev" }],
      categories: [{ name: "Cat", channels: [{ name: "one", kind: "text" }] }],
      uncategorized: [{ name: "lone", kind: "voice" }],
    },
  });
  const data = result.structuredContent as {
    step_count: number;
    steps: { key: string; kind: string; label: string; parent: string | null }[];
  };
  assert.equal(data.step_count, 4);
  assert.deepEqual(
    data.steps.map((s) => s.parent),
    [null, null, "Cat", null],
  );
});

test("architect_apply previews by default and never reports created entities", async () => {
  const result = await handler("discord_architect_apply")({
    guild_id: "111111111111111111",
    plan: {
      roles: [{ key: "dev", name: "Dev" }],
      categories: [{ name: "Cat", channels: [{ name: "one", kind: "text" }] }],
      uncategorized: [],
    },
  });
  const data = result.structuredContent as {
    mode: string;
    applied: boolean;
    created: unknown[];
    skipped: { reason: string }[];
  };
  assert.equal(data.mode, "preview");
  assert.equal(data.applied, false);
  assert.deepEqual(data.created, [], "a preview must create nothing");
  assert.ok(data.skipped.every((s) => s.reason === "preview only"));
});

test("architect_apply advertises confirm:false as its default in the input schema", () => {
  const d = definition("discord_architect_apply");
  const props = d.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.confirm!.default, false);
  assert.ok(!(d.inputSchema.required as string[]).includes("confirm"));
});

test("architect_delete_structure advertises and enforces the literal confirmation", async () => {
  const d = definition("discord_architect_delete_structure");
  const props = d.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.ok(props.confirmation, "confirmation must be advertised");
  assert.equal(props.confirmation!.const, "CONFIRM DELETE");

  const result = await handler("discord_architect_delete_structure")({
    guild_id: "111111111111111111",
    channel_ids: ["333333333333333333"],
  });
  const data = result.structuredContent as {
    mode: string;
    applied: boolean;
    deleted_channels: string[];
  };
  assert.equal(data.mode, "preview");
  assert.equal(data.applied, false);
  assert.deepEqual(data.deleted_channels, [], "without the phrase nothing is deleted");
});

test("architect_explain_limits states that a bot cannot create a guild", async () => {
  const result = await handler("discord_architect_explain_limits")({});
  const data = result.structuredContent as {
    cannot_do: { operation: string; reason: string }[];
    recommended_workflow: string[];
  };
  assert.ok(data.cannot_do.some((c) => /brand-new Discord server/.test(c.operation)));
  assert.ok(
    data.cannot_do.some((c) => /user OAuth2 bearer token, not a bot token/.test(c.reason)),
    "the limitation must cite the API reason",
  );
  assert.ok(data.recommended_workflow.length >= 4);
});

test("the architect's destructive and non-destructive tools are annotated correctly", () => {
  const readOnly = [
    "discord_architect_plan",
    "discord_architect_read_structure",
    "discord_architect_compare",
    "discord_architect_explain_limits",
  ];
  for (const name of readOnly) {
    assert.equal(definition(name).annotations?.readOnlyHint, true, `${name} should be read-only`);
  }
  assert.equal(definition("discord_architect_apply").annotations?.idempotentHint, true);
  assert.equal(definition("discord_architect_delete_structure").annotations?.destructiveHint, true);
});
