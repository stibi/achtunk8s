import { strict as assert } from "node:assert";
import {
  answer,
  claim,
  claimed,
  detail,
  findings,
  handOver,
  progress,
  read,
  register,
  type Target,
} from "./target.ts";

export interface Scenario {
  readonly name: string;
  run(target: Target): Promise<void>;
}

const stateOf = async (target: Target, id: number) => (await read(target, id)).body.state;

/** What the clock alone does: leases, deadlines, expiry, and who counts as connected. */
export const clockScenarios: readonly Scenario[] = [
  {
    name: "a handover whose lease runs out fails as handler lost",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);

      await target.advance(120);

      const { body } = await read(target, id);
      assert.equal(body.state, "failed");
      assert.match(body.error ?? "", /handler lost/);
      assert.equal((await progress(target, id, claimToken)).body.state, "failed");
      assert.equal((await answer(target, id, claimToken, findings)).status, 409);
    },
  },
  {
    name: "a handover past its action's timeout is timed out, whatever its lease",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);
      for (let minute = 0; minute < 10; minute++) {
        await target.advance(60);
        await progress(target, id, claimToken);
      }

      assert.equal(await stateOf(target, id), "timed_out");
    },
  },
  {
    name: "a handover nobody claims for 10 minutes expires and can't be claimed",
    run: async (target) => {
      await register(target);
      const { body } = await handOver(target);

      await target.advance(600);

      assert.equal(await stateOf(target, body.id), "expired");
      assert.equal((await claim(target)).status, 204);
    },
  },
  {
    name: "a handler that stopped calling isn't handed anything until it calls again",
    run: async (target) => {
      await register(target);
      await target.advance(90);

      assert.equal((await handOver(target)).status, 409);
      await claim(target);
      assert.equal((await handOver(target)).status, 201);
    },
  },
  {
    name: "a handler holding a running handover counts as connected",
    run: async (target) => {
      const { id, claimToken } = await claimed(target);
      await target.advance(100);
      await progress(target, id, claimToken);
      await target.advance(100);

      const { body } = await detail(target);

      assert.equal(body.actions[0]?.available, true);
    },
  },
];
