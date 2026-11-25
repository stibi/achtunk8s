import { strict as assert } from "node:assert";
import { clockScenarios, type Scenario } from "./clock.ts";
import {
  answer,
  cancel,
  claim,
  claimed,
  detail,
  findings,
  handler,
  handOver,
  progress,
  read,
  register,
  registration,
  remove,
  type Target,
} from "./target.ts";

export type { Scenario } from "./clock.ts";
export type { Target } from "./target.ts";

// The handover protocol (docs/handover-protocol.md) as scenarios against a server's HTTP
// API. Each needs a fresh server. The real server and the SDK's fake server both pass them;
// that is what keeps the fake honest.

const stateOf = async (target: Target, id: number) => (await read(target, id)).body.state;

export const scenarios: readonly Scenario[] = [
  {
    name: "a registered handler's action is offered on the alert, available",
    run: async (target) => {
      assert.equal((await register(target)).status, 200);

      const { body } = await detail(target);

      assert.equal(body.actions.length, 1);
      assert.deepEqual(
        { ...body.actions[0], lastSeenAt: null },
        {
          handler,
          handlerName: "Conformance handler",
          action: "look",
          title: "Look at It",
          description: "Looks.",
          available: true,
          lastSeenAt: null,
        },
      );
    },
  },
  {
    name: "an action is offered only on the alerts it applies to",
    run: async (target) => {
      const scoped = (severity: string) => ({
        ...registration,
        actions: [{ id: "look", title: "Look", appliesTo: { severities: [severity] } }],
      });
      await register(target, scoped("critical"));
      assert.equal((await detail(target)).body.actions.length, 0);
      assert.equal((await handOver(target)).status, 409);

      await register(target, scoped("warning"));

      assert.equal((await detail(target)).body.actions.length, 1);
    },
  },
  {
    name: "a registration without actions is refused",
    run: async (target) => {
      assert.equal((await register(target, { ...registration, actions: [] })).status, 400);
    },
  },
  {
    name: "a registration over the limits is refused",
    run: async (target) => {
      const withAction = (action: object) => ({
        ...registration,
        actions: [{ id: "look", title: "Look", ...action }],
      });

      const replies = await Promise.all([
        register(target, withAction({ title: "x".repeat(41) })),
        register(target, withAction({ timeoutSeconds: 59 })),
        register(target, withAction({ timeoutSeconds: 3601 })),
        register(target, withAction({ description: "x".repeat(201) })),
        register(target, { ...registration, name: "x".repeat(61) }),
        register(target, {
          ...registration,
          actions: [...registration.actions, ...registration.actions],
        }),
      ]);

      assert.deepEqual(
        replies.map((reply) => reply.status),
        [400, 400, 400, 400, 400, 400],
      );
    },
  },
  {
    name: "a handler the server forgot is told so when it claims",
    run: async (target) => {
      await register(target);

      assert.equal((await remove(target)).status, 204);
      assert.equal((await claim(target)).status, 404);
    },
  },
  {
    name: "a handover cancelled before it was claimed is never handed out",
    run: async (target) => {
      await register(target);
      const { body } = await handOver(target);

      await cancel(target, body.id);

      assert.equal((await claim(target)).status, 204);
    },
  },
  {
    name: "a claim by a handler that isn't registered is a 404",
    run: async (target) => {
      assert.equal((await claim(target)).status, 404);
    },
  },
  {
    name: "a claim with nothing waiting is a 204 without a body",
    run: async (target) => {
      await register(target);

      assert.deepEqual(await claim(target), { status: 204, body: null });
    },
  },
  {
    name: "a handover is claimed once, with the occurrence, a claim token and a lease",
    run: async (target) => {
      await register(target);
      const created = await handOver(target);
      assert.equal(created.status, 201);
      assert.equal(created.body.state, "requested");

      const first = await claim(target);
      const second = await claim(target);

      assert.equal(first.status, 200);
      assert.equal(first.body.id, created.body.id);
      assert.equal(first.body.action, "look");
      assert.equal(first.body.occurrence.id, target.occurrenceId);
      assert.equal(first.body.leaseSeconds, 120);
      assert.equal(typeof first.body.claimToken, "string");
      assert.ok(Array.isArray(first.body.events) && Array.isArray(first.body.otherOccurrences));
      assert.equal(second.status, 204);
      assert.equal(await stateOf(target, created.body.id), "running");
    },
  },
  {
    name: "asking again while one is requested or running returns that one",
    run: async (target) => {
      await register(target);
      const first = await handOver(target);

      const again = await handOver(target);
      await claim(target);
      const whileRunning = await handOver(target);

      assert.deepEqual([again.status, whileRunning.status], [200, 200]);
      assert.deepEqual([again.body.id, whileRunning.body.id], [first.body.id, first.body.id]);
    },
  },
  {
    name: "a claim that waits is answered when a handover is asked for",
    run: async (target) => {
      await register(target);
      const waiting = claim(target, 10);
      await new Promise((resolve) => setTimeout(resolve, 300));

      await handOver(target);

      assert.equal((await waiting).status, 200);
    },
  },
  {
    name: "progress renews the lease and its message is recorded",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);
      await target.advance(100);

      const reply = await progress(target, id, claimToken, "agent started");
      await target.advance(100);

      assert.deepEqual(reply, { status: 200, body: { state: "running", leaseSeconds: 120 } });
      const { body } = await read(target, id);
      assert.equal(body.state, "running");
      assert.deepEqual(
        body.progress.map((line) => line.message),
        ["agent started"],
      );
    },
  },
  {
    name: "a result ends the handover; the same result again is answered as before",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);

      const first = await answer(target, id, claimToken, findings);
      const again = await answer(target, id, claimToken, findings);
      const other = await answer(target, id, claimToken, { ...findings, summary: "Disk full" });

      assert.equal(first.status, 200);
      assert.equal(first.body.state, "succeeded");
      assert.equal(first.body.summary, findings.summary);
      assert.equal(first.body.body, findings.body);
      assert.deepEqual(first.body.links, findings.links);
      assert.equal(again.status, 200);
      assert.equal(other.status, 409);
      assert.equal((await read(target, id)).body.summary, findings.summary);
    },
  },
  {
    name: "a failed result ends the handover as failed, with the reason",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);

      const reply = await answer(target, id, claimToken, { outcome: "failed", error: "No access" });

      assert.equal(reply.status, 200);
      assert.equal(reply.body.state, "failed");
      assert.equal(reply.body.error, "No access");
    },
  },
  {
    name: "a result with a link that isn't http or https is refused",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);
      const links = [{ title: "Open", url: "javascript:alert(1)" }];

      assert.equal((await answer(target, id, claimToken, { ...findings, links })).status, 400);
      assert.equal(await stateOf(target, id), "running");
    },
  },
  {
    name: "a result the server can't keep or show safely is refused",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);
      const link = (url: string) => ({ ...findings, links: [{ title: "Open", url }] });

      const replies = [
        await answer(target, id, claimToken, { ...findings, summary: "x".repeat(301) }),
        await answer(target, id, claimToken, { ...findings, summary: "two\nlines" }),
        await answer(target, id, claimToken, { ...findings, body: "a\u0000b" }),
        await answer(target, id, claimToken, { ...findings, body: "x".repeat(65_537) }),
        await answer(target, id, claimToken, link("https://user:secret@example.com/")),
        await answer(target, id, claimToken, { outcome: "failed", error: " " }),
        await progress(target, id, claimToken, "x".repeat(501)),
      ];

      assert.deepEqual(
        replies.map((reply) => reply.status),
        [400, 400, 400, 400, 400, 400, 400],
      );
      assert.equal(await stateOf(target, id), "running");
    },
  },
  {
    name: "calls without the handover's claim token are refused",
    run: async (target) => {
      const { id } = await claimed(target);

      assert.equal((await progress(target, id, "not-the-token")).status, 403);
      assert.equal((await progress(target, id, "")).status, 403);
      assert.equal((await answer(target, id, "not-the-token", findings)).status, 403);
      assert.equal((await progress(target, id + 100, "not-the-token")).status, 404);
      assert.equal(await stateOf(target, id), "running");
    },
  },
  {
    name: "a cancelled handover tells its handler to stop, and takes no result",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);

      const cancelled = await cancel(target, id);

      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.state, "cancelled");
      assert.equal((await progress(target, id, claimToken)).body.state, "cancelled");
      assert.equal((await answer(target, id, claimToken, findings)).status, 409);
      assert.equal((await cancel(target, id)).status, 409);
    },
  },
  ...clockScenarios,
];
