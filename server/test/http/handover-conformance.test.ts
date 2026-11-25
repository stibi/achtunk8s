import { scenarios } from "@achtung/handover-sdk/conformance";
import { describe, it } from "vitest";
import { handoverApp } from "../handover.ts";

// The protocol scenarios plugin authors rely on (sdk/typescript/conformance), against the
// real server over HTTP. The SDK's fake server passes the same ones.
describe("the server follows the handover protocol", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_, scenario) => {
      const { app, clock, crashLoopId } = await handoverApp();
      const url = await app.listen({ host: "127.0.0.1", port: 0 });

      await scenario.run({ url, occurrenceId: crashLoopId, advance: clock.advance });
    },
  );
});
