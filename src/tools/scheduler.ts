import { z } from "zod";
import { getTextChannel } from "../client.js";
import { recordAction } from "../safety.js";
import { buildEmbed, embedFieldsShape } from "../embeds.js";
import { defineModule, defineTool, intIn, snowflake, structured } from "./define.js";

/**
 * In-process scheduler for one-off and recurring messages.
 *
 * HONEST SCOPE, and it matters: these timers live inside the MCP server process.
 * They fire only while the server is running, and they are lost when it stops.
 * This is a deliberate choice over persisting a queue: an MCP server is spawned
 * by the client (often on demand, over stdio) and has no durable storage, no
 * background worker and no guarantee of uptime. A tool that claimed to "schedule
 * a daily post" across restarts would be lying about where the timer lives.
 *
 * For durable scheduling, use a real scheduler (cron, a GitHub Actions workflow,
 * or an OpenHands automation) that calls this server's send tools. That is stated
 * in every tool description below so a model does not over-promise to a user.
 */

interface ScheduledTask {
  id: string;
  channelId: string;
  content: string | null;
  embed: Record<string, unknown> | null;
  /** Interval in milliseconds; null for a one-off. */
  intervalMs: number | null;
  createdAt: string;
  nextRunAt: string;
  runs: number;
  maxRuns: number | null;
  timer: NodeJS.Timeout;
  lastError: string | null;
}

const tasks = new Map<string, ScheduledTask>();
let nextId = 1;

/** Clears every pending timer. Called on shutdown and by tests. */
export function stopAllScheduledTasks(): void {
  for (const task of tasks.values()) clearTimeout(task.timer);
  tasks.clear();
}

/** Reschedules a recurring task, or drops it once its run budget is exhausted. */
function scheduleNext(task: ScheduledTask): void {
  const delay = task.intervalMs ?? 0;
  task.nextRunAt = new Date(Date.now() + delay).toISOString();
  task.timer = setTimeout(async () => {
    try {
      const channel = await getTextChannel(task.channelId);
      await channel.send({
        content: task.content ?? undefined,
        embeds: task.embed ? [buildEmbed(task.embed as never)] : undefined,
      });
      task.runs += 1;
      task.lastError = null;
      recordAction({
        tool: "discord_scheduled_task",
        guildId: "guildId" in channel ? (channel.guildId ?? null) : null,
        summary: `Fired scheduled message ${task.id} in #${channel.name}`,
        outcome: "applied",
      });
    } catch (err) {
      task.lastError = err instanceof Error ? err.message : String(err);
    }
    const exhausted = task.maxRuns !== null && task.runs >= task.maxRuns;
    if (task.intervalMs !== null && !exhausted) scheduleNext(task);
    else tasks.delete(task.id);
  }, delay);
  // Timers must not hold the process open on their own.
  task.timer.unref?.();
}

/** Tool definitions for scheduling and structured announcements. */
const tools = [
  defineTool({
    name: "discord_schedule_message",
    description:
      "Schedule a message to be sent to a channel after a delay, optionally repeating. IMPORTANT LIMITATION: the timer runs inside this MCP server process, so it fires only while the server is running and is lost when it stops. For a post that must survive a restart, use a durable scheduler (cron, a CI workflow, or an OpenHands automation) that calls discord_send_message instead. Returns the task ID and the time of the next run.",
    annotations: {
      title: "Schedule a message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe("Channel to post in."),
      content: z.string().max(2000).optional().describe("Plain-text body (max 2000 characters)."),
      ...embedFieldsShape,
      delay_seconds: intIn(1, 604_800).describe(
        "Seconds to wait before the first send (1–604800).",
      ),
      repeat_every_seconds: intIn(60, 604_800)
        .optional()
        .describe("Repeat interval in seconds (minimum 60). Omit for a one-off message."),
      max_runs: intIn(1, 1000)
        .optional()
        .describe("Stop after this many sends. Omit to repeat indefinitely while the server runs."),
    }),
    outputSchema: z.object({
      task_id: z.string(),
      next_run_at: z.string(),
      repeats: z.boolean(),
      warning: z.string(),
    }),
    handle: async (args) => {
      if (!args.content && !args.title && !args.description)
        throw new Error(
          "Provide content, or at least one embed field (title/description), so the message is not empty.",
        );
      const channel = await getTextChannel(args.channel_id);
      if (args.repeat_every_seconds !== undefined && args.repeat_every_seconds < 60)
        throw new Error(
          "The minimum repeat interval is 60 seconds; anything shorter is abuse-adjacent.",
        );
      const id = `task_${nextId++}`;
      const embed =
        args.title || args.description ? ({ ...args } as Record<string, unknown>) : null;
      const task: ScheduledTask = {
        id,
        channelId: channel.id,
        content: args.content ?? null,
        embed,
        intervalMs: args.repeat_every_seconds ? args.repeat_every_seconds * 1000 : null,
        createdAt: new Date().toISOString(),
        nextRunAt: "",
        runs: 0,
        maxRuns: args.max_runs ?? null,
        timer: undefined as unknown as NodeJS.Timeout,
        lastError: null,
      };
      scheduleNext(task);
      tasks.set(id, task);
      recordAction({
        tool: "discord_schedule_message",
        guildId: "guildId" in channel ? (channel.guildId ?? null) : null,
        summary: `Scheduled ${id} in #${channel.name} at ${task.nextRunAt}`,
        outcome: "applied",
      });
      return structured({
        task_id: id,
        next_run_at: task.nextRunAt,
        repeats: task.intervalMs !== null,
        warning:
          "This timer lives in the MCP server process: it fires only while the server is running and is lost on restart. Use a durable scheduler for anything that must survive a restart.",
      });
    },
  }),
  defineTool({
    name: "discord_list_scheduled_tasks",
    description:
      "List the messages currently scheduled in this MCP server process, with their channel, next run time, run count and last error. Read-only. Because these timers are in-process, the list is empty after a restart.",
    annotations: { title: "List scheduled tasks", readOnlyHint: true, openWorldHint: false },
    schema: z.object({}),
    outputSchema: z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          channel_id: z.string(),
          next_run_at: z.string(),
          repeats: z.boolean(),
          runs: z.number(),
          last_error: z.string().nullable(),
        }),
      ),
      note: z.string(),
    }),
    handle: async () =>
      structured({
        tasks: [...tasks.values()].map((t) => ({
          id: t.id,
          channel_id: t.channelId,
          next_run_at: t.nextRunAt,
          repeats: t.intervalMs !== null,
          runs: t.runs,
          last_error: t.lastError,
        })),
        note: "In-process timers: they exist only while this MCP server runs.",
      }),
  }),
  defineTool({
    name: "discord_cancel_scheduled_task",
    description:
      "Cancel a scheduled message by its task ID. The message will not be sent again. Returns whether the task existed. Only affects tasks created in this server process; a durable external scheduler is not reachable from here.",
    annotations: {
      title: "Cancel scheduled task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    schema: z.object({
      task_id: z.string().describe("Task ID returned by discord_schedule_message."),
    }),
    outputSchema: z.object({ cancelled: z.boolean(), task_id: z.string() }),
    handle: async ({ task_id }) => {
      const task = tasks.get(task_id);
      if (!task) return structured({ cancelled: false, task_id });
      clearTimeout(task.timer);
      tasks.delete(task_id);
      return structured({ cancelled: true, task_id });
    },
  }),
  defineTool({
    name: "discord_publish_announcement",
    description:
      "Publish a structured announcement to a channel in one call: a title, a body, optional fields, a colour, and an optional ping target. Builds the embed for you so the layout is consistent, and lets you choose the mention policy explicitly instead of relying on the default. SAFE BY DEFAULT for mentions: no mention is parsed unless you pass ping (so '@everyone' inside the body never actually pings). If the channel is an announcement channel and crosspost is true, the message is also published to followers. Requires Send Messages (and Manage Messages to crosspost others' messages).",
    annotations: {
      title: "Publish announcement",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      channel_id: snowflake.describe("Channel to publish in."),
      title: z.string().max(256).describe("Announcement title."),
      body: z.string().max(4000).describe("Announcement body (Markdown supported)."),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "Hex color like '#5865F2'.")
        .default("#5865F2")
        .describe("Side-bar colour."),
      fields: z
        .array(
          z.strictObject({
            name: z.string(),
            value: z.string(),
            inline: z.boolean().optional(),
          }),
        )
        .max(25)
        .optional()
        .describe("Extra embed fields (max 25)."),
      footer: z.string().max(2048).optional().describe("Footer text."),
      ping: z
        .enum(["none", "here", "everyone", "role"])
        .default("none")
        .describe("Who to notify. Default 'none': nothing in the body can ping anyone."),
      ping_role_id: snowflake
        .optional()
        .describe("Role to ping when ping is 'role'. Required in that case."),
      crosspost: z
        .boolean()
        .default(false)
        .describe("Also publish to announcement-channel followers, when the channel supports it."),
    }),
    outputSchema: z.object({
      message_id: z.string(),
      channel_id: z.string(),
      crossposted: z.boolean(),
      pinged: z.string(),
    }),
    handle: async (args) => {
      if (args.ping === "role" && !args.ping_role_id)
        throw new Error("ping is 'role' but ping_role_id was not provided.");
      const channel = await getTextChannel(args.channel_id);
      const pingContent =
        args.ping === "here"
          ? "@here"
          : args.ping === "everyone"
            ? "@everyone"
            : args.ping === "role"
              ? `<@&${args.ping_role_id}>`
              : null;
      // Discord's mention parser has a single 'everyone' token that covers both
      // @everyone and @here; the choice of which one appears is made by the
      // content string, not by allowed_mentions.
      const allowedMentions =
        args.ping === "none"
          ? { parse: [] as const }
          : args.ping === "role"
            ? { roles: [args.ping_role_id!] }
            : { parse: ["everyone"] as const };
      const embed = buildEmbed({
        title: args.title,
        description: args.body,
        color: args.color,
        footer: args.footer,
        fields: args.fields,
      });
      const sent = await channel.send({
        content: pingContent ?? undefined,
        embeds: [embed],
        allowedMentions,
      });
      let crossposted = false;
      if (args.crosspost && channel.type === 5) {
        await sent.crosspost().then(
          () => {
            crossposted = true;
          },
          () => {
            crossposted = false;
          },
        );
      }
      recordAction({
        tool: "discord_publish_announcement",
        guildId: "guildId" in channel ? (channel.guildId ?? null) : null,
        summary: `Published "${args.title}" in #${channel.name}`,
        outcome: "applied",
      });
      return structured({
        message_id: sent.id,
        channel_id: channel.id,
        crossposted,
        pinged: args.ping,
      });
    },
  }),
];

export default defineModule(tools);
