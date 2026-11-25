import { describe, it } from "vitest";
import { scenarios } from "../conformance/index.ts";
import { fakeServer } from "./fake.ts";

// The fake server passes the same scenarios as the real one (server/test/http).
describe("the fake server follows the handover protocol", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_, scenario) => {
      await scenario.run(await fakeServer());
    },
  );
});
